/**
 * WP-EMAIL-R1a — durable order-confirmation delivery (0074).
 *
 *   A. sendEmail: Idempotency-Key, timeout, and how every Resend answer is
 *      classified (accepted / uncertain / retryable / failed). Fake fetch.
 *   B. 0074 in real PostgreSQL 17.6: access, enqueue, claim, lease, backoff,
 *      the 23-hour window, max attempts, immutability, retention, rollback.
 *   C. attemptOrderConfirmation end to end against that database and a FAKE
 *      Resend that models Resend's idempotency (same key + same payload → the
 *      original id, no second email; same key + different payload → 409
 *      invalid_idempotent_request): success, errors, timeouts, crashes at
 *      every step, concurrent attempts, duplicate settlement calls.
 *
 *   PG_HARNESS_DIR=<dir with embedded-postgres@17.6.0-beta.15> npx tsx scripts/order-confirmation-delivery.test.ts
 *
 * Contacts nothing: every fetch is a fake, RESEND_API_KEY is a dummy set here,
 * and the database is a throwaway local cluster. Part A runs without the
 * harness; B and C are SKIPPED (and say so) without it.
 */
import { asRoot, asService, asUser, failure, startEngine, type Client } from "./pg-world";
import { classifyResendError, sendEmail, type SendResult } from "../lib/email";
import {
  attemptOrderConfirmation,
  enqueueOrderConfirmation,
  payloadHash,
  type AttemptDeps,
} from "../lib/orderConfirmationDelivery";
import type { RenderedConfirmation } from "../lib/sendOrderConfirmation";

process.env.RESEND_API_KEY = "re_" + "dummy_key_for_tests_only_000000";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown, note = "") {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else {
    failed++;
    console.log(`  FAIL  ${name}${note ? ` — ${note}` : ""}`);
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── A fake fetch / fake Resend ──────────────────────────────────────────────
type Call = { key: string | null; body: string; signal: boolean };
type Reply = { status: number; body?: unknown } | "hang" | "throw" | "slow-200";

/**
 * Behaves like Resend for one test: answers from a script of replies, and
 * models idempotency across calls — a key seen before with the same body
 * returns the first id and sends nothing; with a different body, 409.
 */
function fakeResend(script: Reply[] = []) {
  const calls: Call[] = [];
  const keys = new Map<string, { body: string; id: string }>();
  let sent = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const key = headers["Idempotency-Key"] ?? null;
    const body = String(init.body);
    calls.push({ key, body, signal: !!init.signal });
    const reply = script.length ? script.shift()! : { status: 200 };
    if (reply === "throw") throw new TypeError("fetch failed");
    if (reply === "hang" || reply === "slow-200") {
      // Resend may still process a request whose answer we never see.
      if (reply === "hang" && key && !keys.has(key)) {
        keys.set(key, { body, id: `re_${++sent}` });
      }
      await new Promise<void>((resolve, reject) => {
        if (reply === "slow-200") return setTimeout(resolve, 150);
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    }
    const status = reply === "slow-200" || reply === "hang" ? 200 : reply.status;
    if (status === 200) {
      let id: string;
      if (key && keys.has(key)) {
        const prior = keys.get(key)!;
        if (prior.body !== body) {
          return new Response(JSON.stringify({ name: "invalid_idempotent_request", message: "x" }), { status: 409 });
        }
        id = prior.id;
      } else {
        id = `re_${++sent}`;
        if (key) keys.set(key, { body, id });
      }
      const payload = reply !== "slow-200" && reply !== "hang" && reply.body !== undefined ? reply.body : { id };
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    return new Response(JSON.stringify(typeof reply === "object" ? reply.body ?? {} : {}), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, keys, emailsSent: () => sent };
}

const msg = { to: "a@b.c", subject: "S", html: "<p>h</p>", text: "t" };

// ══ A. sendEmail ═════════════════════════════════════════════════════════════
async function partA() {
  console.log("A. sendEmail");
  let f = fakeResend([{ status: 200, body: { id: "re_ok" } }]);
  let r = await sendEmail({ ...msg, idempotencyKey: "order-confirmation/x/1", timeoutMs: 1000 }, { fetch: f.fetchImpl });
  check("200 with id → accepted", [r.ok, r.outcome, r.id, r.httpStatus], [true, "accepted", "re_ok", 200]);
  check("Idempotency-Key header sent, with a timeout signal", [f.calls[0].key, f.calls[0].signal], ["order-confirmation/x/1", true]);

  f = fakeResend([{ status: 200, body: { id: "re_ok" } }]);
  r = await sendEmail(msg, { fetch: f.fetchImpl });
  check("existing callers (no key, no timeout): no header, no signal, ok", [f.calls[0].key, f.calls[0].signal, r.ok], [null, false, true]);

  const cases: [number, string | null, string][] = [
    [429, "rate_limit_exceeded", "retryable"],
    [429, "daily_quota_exceeded", "retryable"],
    [409, "concurrent_idempotent_requests", "retryable"],
    [409, "resource_locked", "retryable"],
    [409, "invalid_idempotent_request", "failed"],
    [409, null, "uncertain"],
    [400, "validation_error", "failed"],
    [400, "invalid_idempotency_key", "failed"],
    [401, "missing_api_key", "failed"],
    [403, "validation_error", "failed"],
    [404, "not_found", "failed"],
    [422, "missing_required_field", "failed"],
    [500, "application_error", "uncertain"],
    [503, "service_unavailable", "uncertain"],
  ];
  for (const [status, name, want] of cases) {
    f = fakeResend([{ status, body: name ? { name, message: "m" } : {} }]);
    r = await sendEmail({ ...msg, idempotencyKey: "k" }, { fetch: f.fetchImpl });
    check(`${status} ${name ?? "(no name)"} → ${want}`, [r.ok, r.outcome, r.httpStatus, r.errorName], [false, want, status, name]);
  }
  check("classifier agrees", classifyResendError(502, null), "uncertain");

  f = fakeResend([{ status: 200, body: {} }]);
  r = await sendEmail(msg, { fetch: f.fetchImpl });
  check("200 without an id → uncertain, not accepted", [r.ok, r.outcome, r.errorName], [false, "uncertain", "no_id"]);
  f = fakeResend([{ status: 200, body: "not json" }]);
  r = await sendEmail(msg, { fetch: f.fetchImpl });
  check("200 unreadable → uncertain", r.outcome, "uncertain");

  f = fakeResend(["throw"]);
  r = await sendEmail(msg, { fetch: f.fetchImpl });
  check("network failure → uncertain (may have reached Resend)", [r.outcome, r.errorName], ["uncertain", "network"]);

  f = fakeResend(["hang"]);
  const t0 = Date.now();
  r = await sendEmail({ ...msg, idempotencyKey: "k-hang", timeoutMs: 60 }, { fetch: f.fetchImpl });
  check("hang → aborted at the timeout → uncertain", [r.outcome, r.errorName, Date.now() - t0 < 1000], ["uncertain", "timeout", true]);

  f = fakeResend();
  r = await sendEmail({ ...msg, idempotencyKey: "x".repeat(257) }, { fetch: f.fetchImpl });
  check("over-long key refused before any request", [r.outcome, f.calls.length], ["failed", 0]);

  const saved = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  f = fakeResend();
  r = await sendEmail(msg, { fetch: f.fetchImpl });
  check("not configured → retryable, no request", [r.outcome, r.errorName, f.calls.length], ["retryable", "not_configured", 0]);
  process.env.RESEND_API_KEY = saved;
}

// ══ B/C helpers ══════════════════════════════════════════════════════════════
type Supa = AttemptDeps["supabase"];

/** The four 0074 RPCs through a real connection as service_role, PostgREST-shaped. */
function rpcClient(c: Client, opts: { failOn?: Set<string> } = {}): Supa {
  const sql: Record<string, [string, string[]]> = {
    enqueue_order_confirmation: ["select * from public.enqueue_order_confirmation($1)", ["p_order_id"]],
    claim_order_email_delivery: ["select * from public.claim_order_email_delivery($1, $2)", ["p_delivery_id", "p_lease_seconds"]],
    begin_order_email_request: [
      "select * from public.begin_order_email_request($1, $2, $3, $4, $5, $6)",
      ["p_delivery_id", "p_lease_token", "p_subject", "p_html", "p_text", "p_sha256"],
    ],
    record_order_email_outcome: [
      "select public.record_order_email_outcome($1, $2, $3, $4, $5, $6, $7) as r",
      ["p_delivery_id", "p_lease_token", "p_outcome", "p_provider_message_id", "p_http_status", "p_error_code", "p_error"],
    ],
  };
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (opts.failOn?.has(fn)) return { data: null, error: { code: "08006", message: "connection lost (injected)" } };
      const q = sql[fn];
      if (!q) return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } };
      try {
        const res = await c.query(q[0], q[1].map((k) => args[k] ?? null));
        return { data: fn === "record_order_email_outcome" ? res.rows[0]?.r : res.rows, error: null };
      } catch (e) {
        return { data: null, error: { code: (e as { code?: string }).code, message: (e as Error).message } };
      }
    },
  } as unknown as Supa;
}

async function main() {
  await partA();

  const engine = await startEngine();
  if (!engine) {
    console.log("SKIPPED B and C — embedded-postgres not found (set PG_HARNESS_DIR). The database was NOT verified.");
    console.log(`\n${passed} passed, ${failed} failed (B/C skipped)`);
    process.exit(failed ? 1 : 0);
  }
  console.log(`engine: ${engine.version.split(" ").slice(0, 2).join(" ")} (embedded, throwaway)`);

  const conns: Client[] = [];
  try {
    await engine.database("r1a");
    const root = await engine.connect("r1a");
    const svc = await engine.connect("r1a");
    conns.push(root, svc);
    await asRoot(root);
    await asService(svc);

    const one = async (q: string, a: unknown[] = []) => (await root.query(q, a)).rows[0];
    let n = 0;
    const order = async (o: { paid?: boolean; email?: string | null; sent?: boolean } = {}) =>
      (await one(
        `insert into orders (customer_email, total_inr, payment_status, items, confirmation_sent_at)
         values ($1, 2950, $2, $3::jsonb, $4) returning id`,
        [
          o.email === undefined ? `c${++n}@example.test` : o.email,
          o.paid === false ? "pending" : "paid",
          JSON.stringify([{ id: "p", size: "M", quantity: 1, price_inr: 2950 }]),
          o.sent ? new Date().toISOString() : null,
        ]
      )).id as string;
    const row = async (id: string) => one("select * from order_email_deliveries where id = $1", [id]);
    /** Fixture surgery the trigger would refuse (it is right to): replica mode skips triggers. */
    const surgery = async (q: string, a: unknown[] = []) => {
      await root.query("set session_replication_role = replica");
      try {
        await root.query(q, a);
      } finally {
        await root.query("set session_replication_role = origin");
      }
    };
    const due = (id: string) => root.query("update order_email_deliveries set next_attempt_at = now() - interval '1 second' where id = $1", [id]);
    const expireLease = (id: string) => root.query("update order_email_deliveries set lease_expires_at = now() - interval '1 second' where id = $1", [id]);
    const svcRpc = rpcClient(svc);
    const enqueue = async (orderId: string) => (await svc.query("select * from enqueue_order_confirmation($1)", [orderId])).rows[0];
    const claim = async (id: string, c: Client = svc) => (await c.query("select * from claim_order_email_delivery($1, 90)", [id])).rows[0] ?? null;
    const begin = async (id: string, token: string, html = "<p>H</p>") =>
      (await svc.query("select * from begin_order_email_request($1, $2, 'Subj', $3, 'T', $4)", [id, token, html, "a".repeat(64)])).rows[0] ?? null;
    const recordOutcome = async (id: string, token: string | null, outcome: string, mid: string | null = null) =>
      (await svc.query("select record_order_email_outcome($1, $2, $3, $4, 200, null, null) r", [id, token, outcome, mid])).rows[0].r;

    // ══ B. 0074 ══════════════════════════════════════════════════════════════
    console.log("B1. Access");
    {
      const o = await order({ email: "own@example.test" });
      const d = (await enqueue(o)).delivery_id;
      const anon = await engine.connect("r1a");
      const cust = await engine.connect("r1a");
      conns.push(anon, cust);
      await anon.query("set role anon");
      const uid = (await one("insert into auth.users (email) values ('own@example.test') returning id")).id;
      await asUser(cust, uid, "aal1");
      // The shim's auth.email() reads this claim, as PostgREST sets it from the token.
      await cust.query("select set_config('request.jwt.claim.email', 'own@example.test', false)");
      check("anon cannot read the table", /permission denied/.test(await failure(() => anon.query("select * from order_email_deliveries"))), true);
      check("the order's own customer cannot read it", /permission denied/.test(await failure(() => cust.query("select * from order_email_deliveries"))), true);
      check("…though they can read their order (the reason this is not on orders)", (await cust.query("select id from orders where id = $1", [o])).rows.length, 1);
      for (const [who, c] of [["anon", anon], ["customer", cust]] as const) {
        check(`${who} cannot enqueue`, /permission denied/.test(await failure(() => c.query("select * from enqueue_order_confirmation($1)", [o]))), true);
        check(`${who} cannot claim`, /permission denied/.test(await failure(() => c.query("select * from claim_order_email_delivery($1, 90)", [d]))), true);
        check(`${who} cannot record`, /permission denied/.test(await failure(() => c.query("select record_order_email_outcome($1, null, 'accepted')", [d]))), true);
        check(`${who} cannot expire rows`, /permission denied/.test(await failure(() => c.query("select expire_stale_order_email_deliveries()"))), true);
      }
      check("service_role can read", (await svc.query("select count(*)::int n from order_email_deliveries")).rows[0].n >= 1, true);
      check("service_role cannot update directly", /permission denied/.test(await failure(() => svc.query("update order_email_deliveries set status = 'accepted'"))), true);
      check("service_role cannot insert directly", /permission denied/.test(await failure(() => svc.query("insert into order_email_deliveries (order_id, idempotency_key) values ($1, 'x')", [o]))), true);
      check("service_role cannot delete", /permission denied/.test(await failure(() => svc.query("delete from order_email_deliveries"))), true);
      check("no policies on the table", (await one("select count(*)::int n from pg_policies where tablename = 'order_email_deliveries'")).n, 0);
    }

    console.log("B2. Enqueue");
    {
      const unpaid = await order({ paid: false });
      check("unpaid order: nothing claimed", [await enqueue(unpaid), (await one("select confirmation_sent_at from orders where id = $1", [unpaid])).confirmation_sent_at], [{ delivery_id: null, created: false }, null]);

      const o = await order();
      const first = await enqueue(o);
      const second = await enqueue(o);
      check("first call creates; second returns the same row, not created", [first.created, second.created, second.delivery_id === first.delivery_id], [true, false, true]);
      const r = await row(first.delivery_id);
      check("row: pending, key order-confirmation/<order>/1, recipient frozen", [r.status, r.idempotency_key, r.recipient, r.attempts], ["pending", `order-confirmation/${o}/1`, (await one("select customer_email from orders where id = $1", [o])).customer_email, 0]);
      check("confirmation_sent_at claimed in the same call", !!(await one("select confirmation_sent_at from orders where id = $1", [o])).confirmation_sent_at, true);

      const legacy = await order({ sent: true });
      check("order claimed before 0074: no row, not created (never retried here)", [await enqueue(legacy), (await one("select count(*)::int n from order_email_deliveries where order_id = $1", [legacy])).n], [{ delivery_id: null, created: false }, 0]);

      // Historical: paid before 0058 added the column, so confirmation_sent_at is
      // NULL although the customer was emailed. A replay must not email again.
      const historical = await order();
      await root.query("update orders set created_at = (select orphan_recovery_since from order_email_recovery_settings) - interval '45 days' where id = $1", [historical]);
      check("historical order (45 days before 0074): not claimed, no row", [await enqueue(historical), (await one("select confirmation_sent_at from orders where id = $1", [historical])).confirmation_sent_at, (await one("select count(*)::int n from order_email_deliveries where order_id = $1", [historical])).n], [{ delivery_id: null, created: false }, null, 0]);
      const justBefore = await order();
      await root.query("update orders set created_at = (select orphan_recovery_since from order_email_recovery_settings) - interval '2 hours' where id = $1", [justBefore]);
      check("checkout opened 2 h before 0074, paid after: claimed normally", (await enqueue(justBefore)).created, true);
      const dayBefore = await order();
      await root.query("update orders set created_at = (select orphan_recovery_since from order_email_recovery_settings) - interval '25 hours' where id = $1", [dayBefore]);
      check("created 25 h before 0074: refused", (await enqueue(dayBefore)).created, false);

      const noEmail = await order({ email: null });
      const ne = await enqueue(noEmail);
      const ner = await row(ne.delivery_id);
      check("no email: claimed, row created already failed (no_recipient)", [ne.created, ner.status, ner.last_error_code, ner.recipient], [true, "failed", "no_recipient", null]);
      check("…and never claimable", await claim(ne.delivery_id), null);
      const blank = await order({ email: "   " });
      check("blank email treated as none", (await row((await enqueue(blank)).delivery_id)).status, "failed");

      // Concurrency: 8 connections at once, as browser + webhook + replays would.
      const o2 = await order();
      const cs = await Promise.all(Array.from({ length: 8 }, () => engine.connect("r1a")));
      conns.push(...cs);
      await Promise.all(cs.map(asService));
      const results = await Promise.all(cs.map((c) => c.query("select * from enqueue_order_confirmation($1)", [o2]).then((x) => x.rows[0])));
      check("8 concurrent enqueues: exactly one created", results.filter((x) => x.created).length, 1);
      check("…all name the same row; one row exists", [new Set(results.map((x) => x.delivery_id)).size, (await one("select count(*)::int n from order_email_deliveries where order_id = $1", [o2])).n], [1, 1]);

      const viaApp = await enqueueOrderConfirmation(svcRpc, await order());
      check("enqueueOrderConfirmation (app) reads the RPC", [viaApp.created, typeof viaApp.deliveryId, viaApp.missingMigration], [true, "string", false]);
    }

    console.log("B3. Claim, lease, backoff");
    {
      const d = (await enqueue(await order())).delivery_id;
      const cs = await Promise.all(Array.from({ length: 8 }, () => engine.connect("r1a")));
      conns.push(...cs);
      await Promise.all(cs.map(asService));
      const got = await Promise.all(cs.map((c) => claim(d, c)));
      check("8 concurrent claims: exactly one lease", got.filter(Boolean).length, 1);
      const lease = got.find(Boolean)!;
      check("lease row: sending, attempts 1, token set", [lease.status, lease.attempts, typeof lease.lease_token], ["sending", 1, "string"]);
      check("claim while the lease is live → nothing", await claim(d), null);
      check("lease bounds enforced", /lease must be/.test(await failure(() => svc.query("select * from claim_order_email_delivery($1, 5)", [d]))), true);

      await expireLease(d);
      const again = await claim(d);
      check("expired lease (no request made) → taken over, not possibly accepted", [again?.attempts, again?.possibly_accepted, again?.lease_token !== lease.lease_token], [2, false, true]);
      check("the old holder cannot begin", await begin(d, lease.lease_token), null);
      check("the old holder cannot record a failure", await recordOutcome(d, lease.lease_token, "retryable"), false);

      check("current holder records uncertain", await recordOutcome(d, again.lease_token, "uncertain"), true);
      const u = await row(d);
      check("uncertain: possibly_accepted, backoff ≈ 2 min after attempt 2", [u.status, u.possibly_accepted, u.lease_token, Math.round((new Date(u.next_attempt_at).getTime() - Date.now()) / 60000)], ["uncertain", true, null, 2]);
      check("claim during backoff → nothing", await claim(d), null);
      await due(d);
      check("after backoff → claimable", !!(await claim(d)), true);

      const r2 = (await enqueue(await order())).delivery_id;
      const l2 = await claim(r2);
      await recordOutcome(r2, l2.lease_token, "retryable");
      const rr = await row(r2);
      check("retryable: not possibly accepted, 30 s backoff", [rr.status, rr.possibly_accepted, Math.round((new Date(rr.next_attempt_at).getTime() - Date.now()) / 1000) <= 30], ["retryable", false, true]);

      const f3 = (await enqueue(await order())).delivery_id;
      const l3 = await claim(f3);
      await recordOutcome(f3, l3.lease_token, "failed");
      await due(f3);
      check("failed: never claimable", [(await row(f3)).status, await claim(f3)], ["failed", null]);
      check("unknown outcome refused", /unknown outcome/.test(await failure(() => recordOutcome(f3, null, "delivered"))), true);
    }

    console.log("B4. Payload, request stamp, window, max attempts");
    {
      const d = (await enqueue(await order())).delivery_id;
      const l = await claim(d);
      check("first begin without a payload is refused", /whole payload/.test(await failure(() => svc.query("select * from begin_order_email_request($1, $2, null, null, null, null)", [d, l.lease_token]))), true);
      const b1 = await begin(d, l.lease_token, "<p>FIRST</p>");
      check("begin stores and returns the payload + key", [b1.html_body, b1.idempotency_key.startsWith("order-confirmation/")], ["<p>FIRST</p>", true]);
      const stamped = await row(d);
      check("request time stamped before the call", !!stamped.first_provider_request_at && !!stamped.last_provider_request_at, true);

      // Abandoned mid-request: lease runs out after begin.
      await expireLease(d);
      const l2 = await claim(d);
      check("abandoned after a request began → possibly_accepted", l2.possibly_accepted, true);
      const b2 = await begin(d, l2.lease_token, "<p>DIFFERENT</p>");
      check("retry gets the FROZEN payload, not the new one", b2.html_body, "<p>FIRST</p>");
      check("first request time unchanged by the retry", (await row(d)).first_provider_request_at.getTime(), stamped.first_provider_request_at.getTime());

      check("direct edit of the frozen payload is refused (trigger)", /frozen/.test(await failure(() => root.query("update order_email_deliveries set html_body = 'x' where id = $1", [d]))), true);
      check("identity is immutable", /immutable/.test(await failure(() => root.query("update order_email_deliveries set idempotency_key = 'x' where id = $1", [d]))), true);
      check("recipient is immutable", /immutable/.test(await failure(() => root.query("update order_email_deliveries set recipient = 'evil@example.test' where id = $1", [d]))), true);
      check("first request time is immutable", /immutable/.test(await failure(() => root.query("update order_email_deliveries set first_provider_request_at = now() where id = $1", [d]))), true);
      check("possibly_accepted cannot be cleared", /cannot be cleared/.test(await failure(() => root.query("update order_email_deliveries set possibly_accepted = false where id = $1", [d]))), true);
      check("an unfinished row keeps its payload (a retry needs it)", (await row(d)).html_body, "<p>FIRST</p>");
      check("the trigger refuses dropping the payload of an unfinished row", /only a finished row/.test(await failure(() => root.query("update order_email_deliveries set html_body = null, text_body = null where id = $1", [d]))), true);

      // The window: possibly accepted, first request 23 h ago.
      await recordOutcome(d, l2.lease_token, "uncertain");
      await surgery("update order_email_deliveries set first_provider_request_at = now() - interval '23 hours 1 minute', next_attempt_at = now() - interval '1 second' where id = $1", [d]);
      check("possibly accepted + 23 h since first request → not claimed", await claim(d), null);
      check("…marked expired, never retried automatically", [(await row(d)).status, (await row(d)).last_error_code], ["expired", "idempotency_window_passed"]);

      // Definitely not accepted (429s only): the window does not apply.
      const r = (await enqueue(await order())).delivery_id;
      const lr = await claim(r);
      await begin(r, lr.lease_token);
      await recordOutcome(r, lr.lease_token, "retryable");
      await surgery("update order_email_deliveries set first_provider_request_at = now() - interval '30 hours', next_attempt_at = now() - interval '1 second' where id = $1", [r]);
      check("definitely-not-accepted row past 23 h is still retried (no duplicate possible)", !!(await claim(r)), true);

      // Max attempts.
      const m = (await enqueue(await order())).delivery_id;
      await root.query("update order_email_deliveries set attempts = 5 where id = $1", [m]);
      check("5 attempts used → failed (max_attempts), not claimed", [await claim(m), (await row(m)).status, (await row(m)).last_error_code], [null, "failed", "max_attempts"]);
      const mp = (await enqueue(await order())).delivery_id;
      const lmp = await claim(mp);
      await begin(mp, lmp.lease_token);
      await recordOutcome(mp, lmp.lease_token, "uncertain");
      await root.query("update order_email_deliveries set attempts = 5, next_attempt_at = now() - interval '1 second' where id = $1", [mp]);
      check("5 attempts, possibly accepted → expired (a person checks Resend)", [await claim(mp), (await row(mp)).status], [null, "expired"]);
    }

    console.log("B5. Accepted, stale holders, retention");
    {
      const d = (await enqueue(await order())).delivery_id;
      check("accepted with no recorded request is refused", /without a recorded request/.test(await failure(() => recordOutcome(d, null, "accepted", "re_x"))), true);
      const l1 = await claim(d);
      await begin(d, l1.lease_token);
      await expireLease(d);
      const l2 = await claim(d);
      check("a STALE holder's 'accepted' is recorded (it is a fact about Resend)", await recordOutcome(d, l1.lease_token, "accepted", "re_stale"), true);
      const a = await row(d);
      check("accepted: id kept, lease cleared, accepted_at set", [a.status, a.provider_message_id, a.lease_token, !!a.accepted_at], ["accepted", "re_stale", null, true]);
      check("the current holder can no longer begin or record", [await begin(d, l2.lease_token), await recordOutcome(d, l2.lease_token, "uncertain")], [null, false]);
      check("a second 'accepted' changes nothing", [await recordOutcome(d, null, "accepted", "re_other"), (await row(d)).provider_message_id], [false, "re_stale"]);
      check("accepted is never claimed again", await claim(d), null);
      check("accepted cannot be moved back (trigger)", /stays accepted/.test(await failure(() => root.query("update order_email_deliveries set status = 'uncertain' where id = $1", [d]))), true);

      const p = await row(d);
      check("accepted drops the HTML and text in the same update", [p.html_body, p.text_body, !!p.payload_purged_at], [null, null, true]);
      check("…keeping the record: subject, hash, key, recipient, provider id", [p.subject, !!p.payload_sha256, !!p.idempotency_key, !!p.recipient, p.provider_message_id], ["Subj", true, true, true, "re_stale"]);
      check("a purged payload cannot be written again (trigger)", /frozen/.test(await failure(() => root.query("update order_email_deliveries set html_body = 'x', text_body = 'y' where id = $1", [d]))), true);
    }

    console.log("B6. Retention on every finishing path");
    {
      const finish = async (outcome: string) => {
        const d = (await enqueue(await order())).delivery_id;
        const l = await claim(d);
        await begin(d, l.lease_token);
        await recordOutcome(d, l.lease_token, outcome);
        return row(d);
      };
      const f = await finish("failed");
      check("failed → payload dropped", [f.status, f.html_body, f.text_body, !!f.payload_purged_at], ["failed", null, null, true]);
      const u = await finish("uncertain");
      check("uncertain → payload KEPT (a retry must send the same bytes)", [u.status, u.html_body], ["uncertain", "<p>H</p>"]);
      const r = await finish("retryable");
      check("retryable → payload KEPT", [r.status, r.html_body], ["retryable", "<p>H</p>"]);

      await surgery("update order_email_deliveries set first_provider_request_at = now() - interval '23 hours 1 minute', next_attempt_at = now() - interval '1 second' where id = $1", [u.id]);
      await claim(u.id);
      check("expired (window) → payload dropped", [(await row(u.id)).status, (await row(u.id)).html_body], ["expired", null]);

      await root.query("update order_email_deliveries set attempts = 5, next_attempt_at = now() - interval '1 second' where id = $1", [r.id]);
      await claim(r.id);
      check("max attempts → payload dropped", [(await row(r.id)).status, (await row(r.id)).html_body], ["failed", null]);

      // The backstop for rows nothing ever finishes.
      check("stale expiry refuses under 24 h", /younger than 24 hours/.test(await failure(() => svc.query("select expire_stale_order_email_deliveries(interval '1 hour')"))), true);
      const pend = (await enqueue(await order())).delivery_id;
      const unc = await finish("uncertain");
      const fresh = await finish("uncertain");
      const live = (await enqueue(await order())).delivery_id;
      const liveLease = await claim(live);
      await surgery("update order_email_deliveries set created_at = now() - interval '49 hours' where id = any($1)", [[pend, unc.id, live]]);
      await root.query("update order_email_deliveries set lease_expires_at = now() + interval '5 minutes' where id = $1", [live]);
      const closed = (await svc.query("select expire_stale_order_email_deliveries() n")).rows[0].n;
      check("stale expiry closes old unfinished rows only (not a live lease, not a recent row)", [closed, (await row(live)).status, (await row(fresh.id)).status], [2, "sending", "uncertain"]);
      check("never-requested stale row → failed (stale)", [(await row(pend)).status, (await row(pend)).last_error_code], ["failed", "stale"]);
      check("possibly-accepted stale row → expired, payload dropped", [(await row(unc.id)).status, (await row(unc.id)).html_body, (await row(unc.id)).last_error_code], ["expired", null, "stale"]);
      void liveLease;
    }

    console.log("B7. Anonymisation (account deletion, 0033)");
    {
      // Through the real delete_my_account, as a customer.
      const email = "leaving@example.test";
      const uid = (await one("insert into auth.users (email) values ($1) returning id", [email])).id;
      await root.query("insert into profiles (id, email) values ($1, $2) on conflict (id) do update set email = excluded.email", [uid, email]);
      const done = await order({ email });
      await root.query("update orders set status = 'delivered' where id = $1", [done]);
      const dDone = (await enqueue(done)).delivery_id;
      const lDone = await claim(dDone);
      await begin(dDone, lDone.lease_token);
      await recordOutcome(dDone, null, "accepted", "re_kept");
      const cancelled = await order({ email });
      await root.query("update orders set status = 'delivered' where id = $1", [cancelled]);
      const dStuck = (await enqueue(cancelled)).delivery_id;
      const lStuck = await claim(dStuck);
      await begin(dStuck, lStuck.lease_token);
      await recordOutcome(dStuck, lStuck.lease_token, "uncertain");

      const me = await engine.connect("r1a");
      conns.push(me);
      await asUser(me, uid, "aal1");
      const res = (await me.query("select public.delete_my_account() r")).rows[0].r;
      check("delete_my_account succeeds with deliveries present", res.ok, true);
      const a = await row(dDone);
      check("accepted row: recipient erased, stays accepted, provider id kept", [a.recipient, a.status, a.provider_message_id, a.html_body], [null, "accepted", "re_kept", null]);
      const b = await row(dStuck);
      check("unfinished row: recipient + payload erased, closed (expired: it may have been sent)", [b.recipient, b.html_body, b.text_body, b.status, b.last_error_code, b.lease_token], [null, null, null, "expired", "customer_anonymised", null]);
      check("…and never claimed again", await claim(dStuck), null);
      check("no row anywhere still holds that address", (await one("select count(*)::int n from order_email_deliveries where recipient = $1", [email])).n, 0);

      // Outside the scrub, the recipient still cannot change.
      const other = (await enqueue(await order())).delivery_id;
      check("recipient cannot be blanked outside the scrub", /immutable/.test(await failure(() => root.query("update order_email_deliveries set recipient = null where id = $1", [other]))), true);
      check("recipient cannot be redirected", /immutable/.test(await failure(() => root.query("update order_email_deliveries set recipient = 'evil@example.test' where id = $1", [other]))), true);
      check("an order email changed to another address leaves the frozen recipient", [(await root.query("update orders set customer_email = 'new@example.test' where id = (select order_id from order_email_deliveries where id = $1)", [other])).rowCount, !!(await row(other)).recipient && (await row(other)).recipient !== "new@example.test"], [1, true]);
    }

    console.log("B8. confirmation_sent_at reset by hand");
    {
      const o = await order();
      const first = await enqueue(o);
      await root.query("update orders set confirmation_sent_at = null where id = $1", [o]);
      const again = await enqueue(o);
      check("re-enqueue after a reset: same row, not created, no error", [again.delivery_id === first.delivery_id, again.created], [true, false]);
      check("still exactly one row", (await one("select count(*)::int n from order_email_deliveries where order_id = $1", [o])).n, 1);
    }

    // ══ C. attemptOrderConfirmation end to end ═══════════════════════════════
    console.log("C. Attempts end to end");
    const rendered = (html = "<p>Order</p>"): RenderedConfirmation => ({ ok: true, subject: "Your THE WOVENNE order — ABC", html, text: "Order" });
    const deps = (resend: ReturnType<typeof fakeResend>, extra: Partial<AttemptDeps> = {}) => {
      const renders: string[] = [];
      return {
        renders,
        deps: {
          supabase: svcRpc,
          send: (o: Parameters<typeof sendEmail>[0]) => sendEmail(o, { fetch: resend.fetchImpl }),
          render: async (orderId: string) => {
            renders.push(orderId);
            return rendered(`<p>Order ${renders.length}</p>`);
          },
          configured: () => true,
          timeoutMs: 60,
          leaseSeconds: 90,
          ...extra,
        } as Partial<AttemptDeps>,
      };
    };

    {
      const o = await order();
      const d = (await enqueue(o)).delivery_id;
      const rs = fakeResend();
      const x = deps(rs);
      check("happy path → accepted", await attemptOrderConfirmation(d, x.deps), "accepted");
      const r = await row(d);
      const sentBody = JSON.parse(rs.calls[0].body);
      check("one request, with the row's key", [rs.calls.length, rs.calls[0].key], [1, r.idempotency_key]);
      check("stored hash is the hash of exactly what was sent", r.payload_sha256, payloadHash({ recipient: sentBody.to[0], subject: sentBody.subject, html: sentBody.html, text: sentBody.text }));
      check("accepted: the copy of the email is gone from the database", [r.html_body, r.text_body], [null, null]);
      check("recorded: accepted, provider id", [r.status, r.provider_message_id], ["accepted", "re_1"]);
      check("a second attempt (replay) does nothing", [await attemptOrderConfirmation(d, x.deps), rs.calls.length], ["not_due", 1]);
    }
    {
      // Timeout, then a retry: same key, byte-identical body, Resend dedupes.
      const d = (await enqueue(await order())).delivery_id;
      const rs = fakeResend(["hang"]);
      const x = deps(rs);
      check("timeout → uncertain", await attemptOrderConfirmation(d, x.deps), "uncertain");
      check("…possibly accepted, backing off", [(await row(d)).status, (await row(d)).possibly_accepted], ["uncertain", true]);
      await due(d);
      check("retry → accepted", await attemptOrderConfirmation(d, x.deps), "accepted");
      check("retry used the same key and the identical body; rendered once", [rs.calls[0].key === rs.calls[1].key, rs.calls[0].body === rs.calls[1].body, x.renders.length], [true, true, 1]);
      check("ONE email at Resend despite two requests (key dedupe)", rs.emailsSent(), 1);
      check("recorded id is the first request's", (await row(d)).provider_message_id, "re_1");
    }
    {
      const d = (await enqueue(await order())).delivery_id;
      const rs = fakeResend([{ status: 500, body: { name: "application_error" } }, { status: 200 }]);
      const x = deps(rs);
      check("500 → uncertain", await attemptOrderConfirmation(d, x.deps), "uncertain");
      await due(d);
      check("then 200 → accepted, same body", [await attemptOrderConfirmation(d, x.deps), rs.calls[0].body === rs.calls[1].body], ["accepted", true]);
    }
    {
      const d = (await enqueue(await order())).delivery_id;
      const rs = fakeResend([{ status: 429, body: { name: "rate_limit_exceeded" } }]);
      check("429 → retryable, not possibly accepted", [await attemptOrderConfirmation(d, deps(rs).deps), (await row(d)).possibly_accepted], ["retryable", false]);
    }
    {
      const d = (await enqueue(await order())).delivery_id;
      const rs = fakeResend([{ status: 422, body: { name: "missing_required_field" } }]);
      check("422 → failed; never retried", [await attemptOrderConfirmation(d, deps(rs).deps), (await due(d), await attemptOrderConfirmation(d, deps(rs).deps)), rs.calls.length], ["failed", "not_due", 1]);
    }
    {
      const d = (await enqueue(await order())).delivery_id;
      const rs = fakeResend([{ status: 409, body: { name: "invalid_idempotent_request" } }]);
      check("409 payload mismatch → failed (needs a person)", await attemptOrderConfirmation(d, deps(rs).deps), "failed");
    }
    {
      const d = (await enqueue(await order())).delivery_id;
      const rs = fakeResend([{ status: 409, body: { name: "concurrent_idempotent_requests" } }, { status: 200 }]);
      const x = deps(rs);
      check("409 concurrent → retryable", await attemptOrderConfirmation(d, x.deps), "retryable");
      await due(d);
      check("…then accepted", await attemptOrderConfirmation(d, x.deps), "accepted");
    }
    {
      // Crash after Resend accepted, before the outcome was recorded.
      const d = (await enqueue(await order())).delivery_id;
      const rs = fakeResend();
      const broken = deps(rs, { supabase: rpcClient(svc, { failOn: new Set(["record_order_email_outcome"]) }) });
      await attemptOrderConfirmation(d, broken.deps);
      check("record failed: row left 'sending' under its lease", [(await row(d)).status, rs.emailsSent()], ["sending", 1]);
      check("a retry during the lease does nothing", await attemptOrderConfirmation(d, deps(rs).deps), "not_due");
      await expireLease(d);
      check("after the lease → retried, possibly accepted → accepted", await attemptOrderConfirmation(d, deps(rs).deps), "accepted");
      check("still ONE email at Resend; the recorded id is the original", [rs.emailsSent(), (await row(d)).provider_message_id], [1, "re_1"]);
    }
    {
      // Crash after begin, before the request (send throws).
      const d = (await enqueue(await order())).delivery_id;
      const rs = fakeResend();
      const x = deps(rs, { send: async () => { throw new Error("process killed"); } });
      check("send throws → error, contained", await attemptOrderConfirmation(d, x.deps), "error");
      await expireLease(d);
      check("after the lease: retried with the frozen payload, rendered once", [await attemptOrderConfirmation(d, deps(rs).deps), rs.calls.length], ["accepted", 1]);
    }
    {
      // Crash between claim and begin (begin fails): no request, no window.
      const d = (await enqueue(await order())).delivery_id;
      const rs = fakeResend();
      const x = deps(rs, { supabase: rpcClient(svc, { failOn: new Set(["begin_order_email_request"]) }) });
      check("begin fails → error, nothing sent", [await attemptOrderConfirmation(d, x.deps), rs.calls.length], ["error", 0]);
      const r = await row(d);
      check("…no request stamped, not possibly accepted", [r.first_provider_request_at, r.possibly_accepted], [null, false]);
    }
    {
      const d = (await enqueue(await order())).delivery_id;
      const rs = fakeResend();
      const x = deps(rs, { render: async () => ({ ok: false, retryable: true, reason: "order_load_failed" }) as RenderedConfirmation });
      check("order could not be read → retryable, no request, no window", [await attemptOrderConfirmation(d, x.deps), rs.calls.length, (await row(d)).first_provider_request_at], ["retryable", 0, null]);
      const y = deps(rs, { render: async () => ({ ok: false, retryable: false, reason: "render_failed" }) as RenderedConfirmation });
      const d2 = (await enqueue(await order())).delivery_id;
      check("render failure → failed", await attemptOrderConfirmation(d2, y.deps), "failed");
    }
    {
      const d = (await enqueue(await order())).delivery_id;
      const rs = fakeResend();
      const x = deps(rs, { configured: () => false });
      check("email not configured → retryable, no begin, no window", [await attemptOrderConfirmation(d, x.deps), rs.calls.length, (await row(d)).payload_sha256, (await row(d)).first_provider_request_at], ["retryable", 0, null, null]);
    }
    {
      // Concurrent attempts on one row: one request.
      const d = (await enqueue(await order())).delivery_id;
      const rs = fakeResend(["slow-200"]);
      const cs = await Promise.all(Array.from({ length: 5 }, () => engine.connect("r1a")));
      conns.push(...cs);
      await Promise.all(cs.map(asService));
      const outs = await Promise.all(cs.map((c) => attemptOrderConfirmation(d, { ...deps(rs).deps, supabase: rpcClient(c) })));
      check("5 concurrent attempts → one accepted, four not_due", [outs.filter((o) => o === "accepted").length, outs.filter((o) => o === "not_due").length], [1, 4]);
      check("one request reached Resend", rs.calls.length, 1);
    }
    {
      // Duplicate settlement callbacks, as settleOrder runs them: enqueue + attempt, twice, at once.
      const o = await order();
      const rs = fakeResend(["slow-200"]);
      const [c1, c2] = await Promise.all([engine.connect("r1a"), engine.connect("r1a")]);
      conns.push(c1, c2);
      await asService(c1);
      await asService(c2);
      const settle = async (c: Client) => {
        const q = await enqueueOrderConfirmation(rpcClient(c), o);
        return { created: q.created, out: q.deliveryId ? await attemptOrderConfirmation(q.deliveryId, { ...deps(rs).deps, supabase: rpcClient(c) }) : "none" };
      };
      const [a, b] = await Promise.all([settle(c1), settle(c2)]);
      check("browser + webhook together: one created, one email", [[a.created, b.created].filter(Boolean).length, rs.calls.length, [a.out, b.out].sort()], [1, 1, ["accepted", "not_due"]]);
    }
    {
      // Frozen and resumed after the lease: the late process must not send.
      const d = (await enqueue(await order())).delivery_id;
      const rs = fakeResend();
      let clock = 1_000_000;
      const x = deps(rs, {
        now: () => clock,
        render: async () => {
          clock += 91_000; // the instance slept through its lease
          return rendered();
        },
      });
      check("resumed past its lease → lease_lost, nothing sent", [await attemptOrderConfirmation(d, x.deps), rs.calls.length], ["lease_lost", 0]);
      await expireLease(d);
      check("…the row is taken over normally afterwards", [await attemptOrderConfirmation(d, deps(rs).deps), rs.calls.length], ["accepted", 1]);
    }
    {
      // Window passed on an uncertain row: the attempt does not send.
      const d = (await enqueue(await order())).delivery_id;
      const rs = fakeResend(["hang"]);
      await attemptOrderConfirmation(d, deps(rs).deps);
      await surgery("update order_email_deliveries set first_provider_request_at = now() - interval '24 hours', next_attempt_at = now() - interval '1 second' where id = $1", [d]);
      check("past the window → not_due, expired, no second request", [await attemptOrderConfirmation(d, deps(rs).deps), (await row(d)).status, rs.calls.length], ["not_due", "expired", 1]);
    }
    {
      const missing = rpcClient(svc);
      const fake = { rpc: async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } }) } as unknown as Supa;
      const r = await enqueueOrderConfirmation(fake, await order());
      check("migration missing → missingMigration, nothing created", [r.missingMigration, r.created, r.deliveryId], [true, false, null]);
      void missing;
    }

    // ══ Compatibility and rollback ═══════════════════════════════════════════
    console.log("D. Compatibility and rollback");
    {
      // The pre-R1a application's claim still works with 0074 applied.
      const o = await order();
      const old = await svc.query("update orders set confirmation_sent_at = now() where id = $1 and confirmation_sent_at is null returning id", [o]);
      check("old code's claim UPDATE still works alongside 0074", old.rows.length, 1);
      check("…and that order is then 'legacy' to the new code (no row, no attempt)", await enqueue(o), { delivery_id: null, created: false });

      const before = (await one("select count(*)::int n from orders where confirmation_sent_at is not null")).n;
      const rowsBefore = (await one("select count(*)::int n from order_email_deliveries")).n;
      check("the outstanding-rows query a rollback starts with runs", (await root.query(OUTSTANDING_SQL)).rows.length > 0, true);
      const refused = await failure(() => root.query(REMOVAL_SQL));
      await root.query("rollback"); // the refusal aborts the script's own transaction
      check("schema removal REFUSES while any delivery record exists", /0074 removal refused/.test(refused), true);
      check("…and dropped nothing", [(await one("select to_regclass('public.order_email_deliveries') is not null ok")).ok, (await one("select count(*)::int n from order_email_deliveries")).n], [true, rowsBefore]);

      // A database with no delivery records (a rollback straight after a failed deploy).
      await engine.database("r1a_empty");
      const empty = await engine.connect("r1a_empty");
      conns.push(empty);
      await asRoot(empty);
      await empty.query(REMOVAL_SQL);
      check("removal on an empty table drops the table and every 0074 function and trigger", (await empty.query(
        `select (to_regclass('public.order_email_deliveries') is null)
            and to_regprocedure('public.enqueue_order_confirmation(uuid)') is null
            and to_regprocedure('public.claim_order_email_delivery(uuid, integer)') is null
            and to_regprocedure('public.begin_order_email_request(uuid, uuid, text, text, text, text)') is null
            and to_regprocedure('public.record_order_email_outcome(uuid, uuid, text, text, integer, text, text)') is null
            and to_regprocedure('public.expire_stale_order_email_deliveries(interval)') is null
            and to_regprocedure('public.order_email_deliveries_guard()') is null
            and to_regprocedure('public.order_email_deliveries_scrub()') is null
            and not exists (select 1 from pg_trigger where tgname = 'order_email_deliveries_scrub')
            and to_regclass('public.order_email_recovery_settings') is null
            and to_regclass('public.orders_unconfirmed_paid_idx') is null
            and to_regprocedure('public.list_due_order_email_deliveries(integer)') is null
            and to_regprocedure('public.list_unqueued_paid_orders(integer)') is null
            and to_regprocedure('public.order_email_delivery_summary()') is null ok`)).rows[0].ok, true);
      check("…and leaves orders.confirmation_sent_at untouched (main db)", (await one("select count(*)::int n from orders where confirmation_sent_at is not null")).n, before);
      await asService(empty);
      const app = await enqueueOrderConfirmation(rpcClient(empty), "00000000-0000-4000-8000-000000000000");
      check("after removal the new code refuses (no silent fallback)", [app.missingMigration || /does not exist/.test(String(app.error)), app.created], [true, false]);
    }
  } finally {
    for (const c of conns) await c.end().catch(() => {});
    await engine.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

/**
 * ROLLBACK IS THE CODE, NOT THE TABLE. Reverting the application is the
 * rollback; 0074's objects are additive and the old code ignores them. Before
 * reverting, list what is outstanding (the old code will not send it):
 */
export const OUTSTANDING_SQL = `
select d.id, d.order_id, d.status, d.attempts, d.possibly_accepted, d.first_provider_request_at, d.created_at
  from public.order_email_deliveries d
 where d.status in ('pending', 'sending', 'uncertain', 'retryable')
 order by d.created_at;
`;

/**
 * Removing 0074's schema is a separate, deliberate step, never automatic: it
 * refuses while ANY delivery record exists. Records are archived (encrypted,
 * as the project's backups are) and removed by a person first, with the
 * owner's approval.
 */
export const REMOVAL_SQL = `
begin;
do $$
begin
  if exists (select 1 from public.order_email_deliveries) then
    raise exception '0074 removal refused: order_email_deliveries holds records. Archive them and remove them deliberately first.';
  end if;
end $$;
drop trigger if exists order_email_deliveries_scrub on public.orders;
drop function if exists public.order_email_deliveries_scrub();
drop function if exists public.order_email_delivery_summary();
drop function if exists public.list_unqueued_paid_orders(integer);
drop function if exists public.list_due_order_email_deliveries(integer);
drop table if exists public.order_email_recovery_settings;
drop index if exists public.orders_unconfirmed_paid_idx;
drop function if exists public.expire_stale_order_email_deliveries(interval);
drop function if exists public.record_order_email_outcome(uuid, uuid, text, text, integer, text, text);
drop function if exists public.begin_order_email_request(uuid, uuid, text, text, text, text);
drop function if exists public.claim_order_email_delivery(uuid, integer);
drop function if exists public.enqueue_order_confirmation(uuid);
drop table if exists public.order_email_deliveries;
drop function if exists public.order_email_deliveries_guard();
commit;
`;

const watchdog = setTimeout(() => {
  console.log("  FAIL  the suite did not finish within 120 s");
  process.exit(1);
}, 120_000);
main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => clearTimeout(watchdog));
