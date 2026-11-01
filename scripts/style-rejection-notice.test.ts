/**
 * WP-EMAIL-E5 Stage B: style-photo rejection notices (0076,
 * lib/styleRejectionNotice.ts, /api/admin/style/reject).
 *
 *   A. Unit: claim outcomes → admin messages; send → record for accepted,
 *      refused, not configured, 5xx, network, timeout; record failure; the
 *      Stage A template is what is sent; "accepted" never called delivered.
 *   B. Route source: order of gate → same-origin → is_admin → storage →
 *      moderate → sweep → claim → send → record; no direct stamp writes.
 *   C. Real PostgreSQL (embedded-postgres, PG 17.6, via scripts/pg-world):
 *      privileges, repeated and CONCURRENT rejection and claims, same and
 *      different reasons, silent rejection, resubmission → new round,
 *      approval/withdrawal, interruption after claim, no recipient, admin
 *      without MFA, customer tampering, backfill from a 0073 database,
 *      account deletion.
 *
 *   PG_HARNESS_DIR=<dir with embedded-postgres@17.6.0-beta.15> npx tsx scripts/style-rejection-notice.test.ts
 *
 * Without the harness the database half is SKIPPED and reported as such
 * (exit 2), never as passed. Nothing here reads .env.local or sends email.
 */
import fs from "node:fs";
import path from "node:path";
import {
  classifyProviderError,
  claimMessage,
  sendClaimedRejection,
  type BeginFn,
  type BeginResult,
  type Claim,
  type RecordFn,
  type SendFn,
} from "../lib/styleRejectionNotice";
import { EMAIL_ORIGIN } from "../lib/emails/layout";
import { asAdmin, asRoot, asStaffPasswordOnly, asUser, failure, makeAdmin, startEngine, type Client } from "./pg-world";

let pass = 0;
let fail = 0;
const t = (name: string, ok: boolean, detail = "") => {
  if (ok) pass++;
  else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const root = path.join(__dirname, "..");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// ══ A. Unit ═══════════════════════════════════════════════════════════════

const claimed: Claim = {
  outcome: "claimed",
  notice_id: "11111111-1111-1111-1111-111111111111",
  round: 1,
  attempt: 1,
  recipient: "ananya@example.test",
  customer_name: "Ananya Menon",
  product_name: "Mul Cotton Saree",
  reason: "A little blurry — a sharper one would show the weave.",
};

function fakes(
  answer: Awaited<ReturnType<SendFn>> | (() => Promise<Awaited<ReturnType<SendFn>>>),
  recordError: string | null = null,
  beginAnswer: { data: BeginResult | null; error: string | null } = { data: { send: true, recipient: "ananya@example.test" }, error: null }
) {
  const sent: Parameters<SendFn>[0][] = [];
  const recorded: Parameters<RecordFn>[] = [];
  const begun: string[] = [];
  const begin: BeginFn = async (n) => {
    begun.push(n);
    return beginAnswer;
  };
  const send: SendFn = async (m) => {
    sent.push(m);
    return typeof answer === "function" ? answer() : answer;
  };
  const record: RecordFn = async (...a) => {
    recorded.push(a);
    return { error: recordError };
  };
  return { send, begin, record, sent, recorded, begun };
}

async function unit() {
  {
    const f = fakes({ ok: true, id: "re_123", error: null });
    const r = await sendClaimedRejection(claimed, f);
    t("accepted: emailed true", r.emailed && r.status === "accepted");
    t("accepted: not called delivered", /accepted by the email provider/.test(r.message) && /does not confirm it reached their inbox/.test(r.message));
    t("accepted: sent once, to the claimed recipient", f.sent.length === 1 && f.sent[0].to === "ananya@example.test");
    t("accepted: Stage A template", f.sent[0].subject === "About the photograph you sent us — Mul Cotton Saree" && f.sent[0].html.includes("Send another photograph") && f.sent[0].html.includes(`${EMAIL_ORIGIN}/in/account/orders`));
    t("accepted: reason from the claim", f.sent[0].text.includes("A little blurry"));
    t("accepted: recorded with provider id", f.recorded.length === 1 && f.recorded[0][1] === "accepted" && f.recorded[0][2] === "re_123");
  }
  for (const [err, outcome] of [
    ["Resend 422", "failed"],
    ["Resend 403", "failed"],
    ["Resend 429", "failed"],
    ["Email is not configured.", "failed"],
    ["Resend 500", "uncertain"],
    ["Resend 503", "uncertain"],
    ["Send failed.", "uncertain"],
    [null, "uncertain"],
  ] as const) {
    const f = fakes({ ok: false, id: null, error: err });
    const r = await sendClaimedRejection(claimed, f);
    t(`provider ${err}: ${outcome}`, r.status === outcome && !r.emailed && f.recorded[0]?.[1] === outcome, r.status);
    if (outcome === "failed") t(`provider ${err}: says not sent`, /was not sent/.test(r.message));
    if (outcome === "uncertain") t(`provider ${err}: not known, not resent`, /not known whether/.test(r.message) && /will not be resent automatically/.test(r.message));
  }
  {
    const f = fakes(() => Promise.reject(new Error("socket hang up")));
    const r = await sendClaimedRejection(claimed, f);
    t("send throws: uncertain, recorded", r.status === "uncertain" && f.recorded[0][1] === "uncertain");
  }
  {
    const f = fakes(() => new Promise(() => {}));
    const started = Date.now();
    const r = await sendClaimedRejection(claimed, { ...f, timeoutMs: 30 });
    t("timeout: uncertain with detail", r.status === "uncertain" && f.recorded[0][3] === "timeout" && Date.now() - started < 2000);
  }
  {
    const f = fakes({ ok: true, id: "re_1", error: null }, "connection reset");
    const r = await sendClaimedRejection(claimed, f);
    t("accepted but not recorded: says do not resend", r.status === "not_recorded" && r.emailed && /Do not send it again/.test(r.message));
    const g = fakes({ ok: false, id: null, error: "Resend 500" }, "connection reset");
    const q = await sendClaimedRejection(claimed, g);
    t("uncertain and not recorded: stays in progress", q.status === "not_recorded" && !q.emailed && /will not be resent automatically/.test(q.message));
  }
  {
    const f = fakes({ ok: true, id: "x", error: null });
    const r = await sendClaimedRejection({ ...claimed, notice_id: undefined }, f);
    t("incomplete claim: nothing begun or sent", r.status === "claim_failed" && f.begun.length === 0 && f.sent.length === 0 && f.recorded.length === 0);
  }
  // The pre-send check (begin_style_rejection_send).
  for (const reason of ["withdrawn", "not_rejected", "round_changed", "no_recipient", "not_found"] as const) {
    const f = fakes({ ok: true, id: "x", error: null }, null, { data: { send: false, reason }, error: null });
    const r = await sendClaimedRejection(claimed, f);
    t(`begin says ${reason}: skipped, nothing sent, nothing recorded`, r.status === "skipped" && !r.emailed && f.sent.length === 0 && f.recorded.length === 0 && /No email was sent/.test(r.message));
  }
  {
    const f = fakes({ ok: true, id: "x", error: null }, null, { data: null, error: "connection reset" });
    const r = await sendClaimedRejection(claimed, f);
    t("begin fails: nothing sent, stays in progress", r.status === "not_begun" && f.sent.length === 0 && f.recorded.length === 0 && /not resent automatically/.test(r.message));
  }
  {
    const f = fakes({ ok: true, id: "x", error: null }, null, { data: { send: true, recipient: "new-address@example.test" }, error: null });
    await sendClaimedRejection(claimed, f);
    t("begin's fresh address is the one used", f.sent[0]?.to === "new-address@example.test");
  }
  {
    const f = fakes({ ok: true, id: "x", error: null });
    const r = await sendClaimedRejection({ ...claimed, reason: "   " }, f);
    t("email that cannot be built: nothing begun or sent", r.status === "not_begun" && f.begun.length === 0 && f.sent.length === 0);
  }
  {
    const f = fakes({ ok: true, id: "x", error: null });
    await sendClaimedRejection(claimed, f);
    t("order: begin before send, record after", f.begun.length === 1 && f.sent.length === 1 && f.recorded.length === 1);
  }
  for (const o of ["already_accepted", "in_progress", "uncertain", "no_recipient", "withdrawn", "no_intent", "silent", "not_rejected", "skipped", "not_found"] as const) {
    const f = fakes({ ok: true, id: "x", error: null });
    const r = await sendClaimedRejection({ outcome: o }, f);
    t(`claim ${o}: nothing begun, sent or recorded`, f.begun.length === 0 && f.sent.length === 0 && f.recorded.length === 0 && !r.emailed && r.status === o && r.message.length > 0);
    t(`claim ${o}: no delivery claim`, !/delivered|reached their inbox\b(?! )/.test(r.message));
  }
  t("already accepted: says no second email", /no second email/.test(claimMessage({ outcome: "already_accepted" }).message));
  t("in progress: says no second email", /no second email/.test(claimMessage({ outcome: "in_progress" }).message));
  t("no recipient: says nobody was told", /no email address on file/.test(claimMessage({ outcome: "no_recipient" }).message));
  t("classify: 404 failed, 502 uncertain", classifyProviderError("Resend 404") === "failed" && classifyProviderError("Resend 502") === "uncertain");
}

// ══ B. Route source ═══════════════════════════════════════════════════════

{
  const r = code(read("app/api/admin/style/reject/route.ts"));
  const at = (s: string) => r.indexOf(s);
  const order = [
    "await adminApiGate(request)",
    "if (!isSameOrigin(request))",
    'rpc("is_admin")',
    "request.json()",
    "removeGalleryCopies(service, [id])",
    'rpc("moderate_style"',
    "sweepStylePhotos(service)",
    'rpc("claim_style_rejection_notice"',
    "sendClaimedRejection(",
    'rpc("begin_style_rejection_send"',
    'rpc("record_style_rejection_notice"',
  ];
  const idx = order.map(at);
  t("route: gate → origin → admin → body → storage → moderate → sweep → claim → begin → record",
    idx.every((v, i) => v > 0 && (i === 0 || v > idx[i - 1])), idx.join(","));
  t("route: no direct stamp write", !/\.update\(\{\s*rejection_emailed_at/.test(r));
  t("route: missing submission → 404 before any claim", /if \(moderated !== true\)/.test(r) && r.indexOf("if (moderated !== true)") < r.indexOf('rpc("claim_style_rejection_notice"') && /status: 404/.test(r));
  t("route: no direct sendEmail call outside the claim path", (r.match(/sendEmail\(/g) ?? []).length === 0 && r.includes("send: sendEmail"));
  t("route: ALREADY_REJECTED → 409, nothing sent", /ALREADY_REJECTED/.test(r) && /status: 409/.test(r));
  t("route: still ok:true with emailed/problem for the screen", r.includes("return NextResponse.json({ ok: true, emailed, problem, notice: report.status, message: report.message })"));
  const ui = read("components/admin/StyleManager.tsx");
  t("screen: shows the route's message", ui.includes("data.message ??"));
  t("screen: no 'has been told' claim", !ui.includes("the customer has been told why") && !ui.includes('" · customer told"'));
  t("screen: sending/uncertain shown as outcome unknown", /case "sending":[\s\S]*EMAIL OUTCOME UNKNOWN/.test(ui) && /case "uncertain":[\s\S]*EMAIL OUTCOME UNKNOWN/.test(ui) && /will not be resent automatically/.test(ui));
  t("screen: claimed shown as not handed over; skipped as not emailed", /case "claimed":[\s\S]*EMAIL NOT HANDED OVER/.test(ui) && /case "skipped":[\s\S]*NOT EMAILED/.test(ui));
  t("screen: accepted is 'accepted by the provider', not 'told'", ui.includes("email accepted by the provider"));
  t("screen: failed and pending distinguished", ui.includes("EMAIL FAILED") && ui.includes("CUSTOMER NOT TOLD yet"));
  const mig = read("supabase/migrations/0076_style_rejection_notices.sql");
  t("migration: no delete of rows, no drop of columns", !/\bdelete from\b/i.test(mig.replace(/^--.*$/gm, "")) && !/drop column/i.test(mig));
  t("migration: approve_style and resubmit_style not redefined", !/function public\.(approve_style|resubmit_style)/.test(mig));
}

// ══ C. Real PostgreSQL ════════════════════════════════════════════════════

async function database() {
  const engine = await startEngine();
  if (!engine) {
    console.log("\n  SKIP  database half — embedded-postgres not found (set PG_HARNESS_DIR). Nothing in it was verified.");
    return false;
  }
  t("harness is PostgreSQL 17.6 (production's version)", /PostgreSQL 17\.6/.test(engine.version), engine.version);
  try {
    // ── Backfill from a database as it stood at 0073 ──
    await engine.database("pre", "0073");
    const pre = await engine.connect("pre");
    await asRoot(pre);
    const P0 = (await pre.query("insert into products (name, slug, price_inr) values ('Saree', 'saree', 1000) returning id")).rows[0].id;
    const mk = async (email: string) => {
      const id = (await pre.query("insert into auth.users (email) values ($1) returning id", [email])).rows[0].id;
      await pre.query("insert into profiles (id, email, full_name) values ($1, $2, 'X') on conflict (id) do update set email = $2", [id, email]);
      return id as string;
    };
    const sub = async (user: string, status: string, reason: string | null, stamped: boolean) =>
      (await pre.query(
        `insert into style_submissions (product_id, user_id, video_platform, video_url, consented_at, status, reject_reason, rejection_emailed_at)
         values ($1, $2, 'instagram', 'https://www.instagram.com/p/abc/', now(), $3, $4, $5) returning id`,
        [P0, user, status, reason, stamped ? "2026-10-20T10:00:00Z" : null])).rows[0].id as string;
    const hEmailed = await sub(await mk("h1@example.test"), "rejected", "Blurry", true);
    const hOwed = await sub(await mk("h2@example.test"), "rejected", "Too dark", false);
    const hSilent = await sub(await mk("h3@example.test"), "rejected", null, false);
    const hApproved = await sub(await mk("h4@example.test"), "approved", null, false);
    await pre.query(fs.readFileSync(path.join(root, "supabase/migrations/0076_style_rejection_notices.sql"), "utf8"));
    const round = async (id: string) => (await pre.query("select rejection_round, rejection_emailed_at from style_submissions where id = $1", [id])).rows[0];
    const notices = async (id: string) => (await pre.query("select * from style_rejection_notices where submission_id = $1 order by round", [id])).rows;
    const e = await notices(hEmailed);
    t("backfill: emailed rejection → round 1, one accepted notice", (await round(hEmailed)).rejection_round === 1 && e.length === 1 && e[0].status === "accepted" && e[0].backfilled === true);
    t("backfill: historical accepted timestamp preserved", new Date(e[0].accepted_at).toISOString() === "2026-10-20T10:00:00.000Z" && new Date((await round(hEmailed)).rejection_emailed_at).toISOString() === "2026-10-20T10:00:00.000Z");
    t("backfill: unemailed rejection → round 1, NO notice", (await round(hOwed)).rejection_round === 1 && (await notices(hOwed)).length === 0);
    t("backfill: silent rejection → round 1, no notice", (await round(hSilent)).rejection_round === 1 && (await notices(hSilent)).length === 0);
    t("backfill: approved untouched (round 0)", (await round(hApproved)).rejection_round === 0);
    const preAdmin = await makeAdmin(pre, "admin-pre@example.test");
    await asAdmin(pre, preAdmin);
    const owed = (await pre.query("select claim_style_rejection_notice($1) c", [hOwed])).rows[0].c;
    t("backfill: historical unemailed is NOT claimable (no automatic email)", owed.outcome === "no_intent");
    const again = (await pre.query("select claim_style_rejection_notice($1) c", [hEmailed])).rows[0].c;
    t("backfill: historical accepted is never reclaimed", again.outcome === "already_accepted");
    await asRoot(pre);
    t("backfill: re-applying 0076 is harmless", (await failure(() => pre.query(fs.readFileSync(path.join(root, "supabase/migrations/0076_style_rejection_notices.sql"), "utf8")))) === ""
      && (await notices(hEmailed)).length === 1);
    await pre.end();

    // ── The full replay ──
    await engine.database("w");
    const c = await engine.connect("w");
    const c2 = await engine.connect("w");
    // State is read on its own owner connection, so reading never changes who
    // the test connections are acting as.
    const rd = await engine.connect("w");
    await asRoot(c);
    const P = (await c.query("insert into products (name, slug, price_inr) values ('Kasavu saree', 'kasavu-saree', 1000) returning id")).rows[0].id as string;
    const users: Record<string, string> = {};
    const customer = async (key: string, email: string | null = `${key}@example.test`) => {
      await asRoot(c);
      const id = (await c.query("insert into auth.users (email) values ($1) returning id", [email ?? `${key}@example.test`])).rows[0].id as string;
      await c.query("insert into profiles (id, email, full_name) values ($1, $2, $3) on conflict (id) do update set email = $2, full_name = $3", [id, email, key]);
      await c.query("insert into orders (customer_email, total_inr, items, payment_status, status) values ($1, 1000, $2::jsonb, 'paid', 'delivered')",
        [`${key}@example.test`, JSON.stringify([{ id: P, name: "x", quantity: 1, price_inr: 1000 }])]);
      users[key] = id;
      return id;
    };
    const as = async (cl: Client, key: string) => {
      await asUser(cl, users[key], "aal1");
      await cl.query("select set_config('request.jwt.claim.email', $1, false)", [`${key}@example.test`]);
    };
    const submission = async (key: string) => {
      await asRoot(c);
      return (await c.query(
        `insert into style_submissions (product_id, user_id, video_platform, video_url, consented_at)
         values ($1, $2, 'instagram', 'https://www.instagram.com/p/abc/', now()) returning id`, [P, users[key]])).rows[0].id as string;
    };
    const state = async (id: string) => {
      const s = (await rd.query("select status, reject_reason, rejection_round, rejection_emailed_at, withdrawn_at from style_submissions where id = $1", [id])).rows[0];
      const n = (await rd.query("select id, round, status, attempts, reason_snapshot, recipient_email, accepted_at from style_rejection_notices where submission_id = $1 order by round", [id])).rows;
      return { s, n };
    };
    const admin = await makeAdmin(c, "admin@example.test");
    const moderate = (cl: Client, id: string, status: string, reason: string | null) => cl.query("select moderate_style($1, $2, $3) r", [id, status, reason]);
    const claim = async (cl: Client, id: string) => (await cl.query("select claim_style_rejection_notice($1) c", [id])).rows[0].c as Claim;
    const record = (cl: Client, notice: string, outcome: string, pid: string | null = null, err: string | null = null) =>
      cl.query("select record_style_rejection_notice($1, $2, $3, $4)", [notice, outcome, pid, err]);
    const begin = async (cl: Client, notice: string) => (await cl.query("select begin_style_rejection_send($1) b", [notice])).rows[0].b as BeginResult;
    // The route's wiring, against the real database, with a mocked provider.
    const realDeps = (cl: Client, send: SendFn) => ({
      send,
      begin: async (n: string) => {
        try {
          return { data: await begin(cl, n), error: null };
        } catch (e) {
          return { data: null, error: (e as Error).message };
        }
      },
      record: async (n: string, o: string, pid: string | null, err: string | null) => {
        try {
          await record(cl, n, o, pid, err);
          return { error: null };
        } catch (e) {
          return { error: (e as Error).message };
        }
      },
      timeoutMs: 2000,
    });

    // ── Privileges ──
    await customer("buyer");
    await customer("other");
    const s1 = await submission("buyer");
    await as(c, "buyer");
    t("customer cannot write rejection_emailed_at on their own row", (await failure(() => c.query("update style_submissions set rejection_emailed_at = null where id = $1", [s1]))) !== "");
    t("customer can still withdraw consent", (await failure(() => c.query("update style_submissions set withdrawn_at = null where id = $1", [s1]))) === "");
    t("customer cannot read notices", (await c.query("select 1 from style_rejection_notices")).rowCount === 0);
    t("customer cannot insert a notice", (await failure(() => c.query("insert into style_rejection_notices (submission_id, round, reason_snapshot) values ($1, 9, 'x')", [s1]))) !== "");
    t("customer cannot update notices", (await failure(() => c.query("update style_rejection_notices set status = 'pending'"))) !== "" || (await c.query("update style_rejection_notices set status = 'pending'").catch(() => ({ rowCount: -1 }))).rowCount !== 1);
    t("customer cannot claim", (await failure(() => claim(c, s1))) !== "");
    t("customer cannot record", (await failure(() => record(c, "00000000-0000-0000-0000-000000000000", "accepted"))) !== "");
    t("customer cannot begin a send", (await failure(() => begin(c, "00000000-0000-0000-0000-000000000000"))) !== "");
    t("customer cannot moderate", (await failure(() => moderate(c, s1, "rejected", "x"))) !== "");
    await asRoot(c);
    await c.query("reset role");
    await c.query("set role anon");
    t("anon cannot claim", (await failure(() => claim(c, s1))) !== "");
    await asStaffPasswordOnly(c, admin);
    t("admin without MFA (aal1) cannot moderate", (await failure(() => moderate(c, s1, "rejected", "x"))) !== "");
    t("admin without MFA (aal1) cannot claim", (await failure(() => claim(c, s1))) !== "");
    t("admin without MFA (aal1) cannot record", (await failure(() => record(c, "00000000-0000-0000-0000-000000000000", "accepted"))) !== "");
    t("admin without MFA (aal1) cannot begin a send", (await failure(() => begin(c, "00000000-0000-0000-0000-000000000000"))) !== "");
    t("…and nothing changed", (await state(s1)).s.status === "pending" && (await state(s1)).n.length === 0);

    // ── A rejection with a reason → one intent ──
    await asAdmin(c, admin);
    await moderate(c, s1, "rejected", "Blurry");
    let st = await state(s1);
    t("reject: round 1, one pending notice with the reason", st.s.rejection_round === 1 && st.n.length === 1 && st.n[0].status === "pending" && st.n[0].reason_snapshot === "Blurry");
    t("reject: stamp still null (nothing accepted yet)", st.s.rejection_emailed_at === null);
    await asAdmin(c, admin);
    await moderate(c, s1, "rejected", "Blurry");
    await moderate(c, s1, "rejected", "  Blurry  ");
    st = await state(s1);
    t("repeat same reason: no new round, no new intent", st.s.rejection_round === 1 && st.n.length === 1);
    await asAdmin(c, admin);
    const diff = await failure(() => moderate(c, s1, "rejected", "Too dark"));
    st = await state(s1);
    t("different reason: refused ALREADY_REJECTED, reason unchanged", /ALREADY_REJECTED/.test(diff) && st.s.reject_reason === "Blurry" && st.n.length === 1);
    await asAdmin(c, admin);
    t("silent on a reasoned rejection: refused (a reason change)", /ALREADY_REJECTED/.test(await failure(() => moderate(c, s1, "rejected", null))));

    // ── Claims ──
    await asAdmin(c, admin);
    const k1 = await claim(c, s1);
    t("first claim wins", k1.outcome === "claimed" && k1.recipient === "buyer@example.test" && k1.reason === "Blurry" && k1.round === 1 && k1.attempt === 1 && k1.product_name === "Kasavu saree");
    const k2 = await claim(c, s1);
    t("second claim: in progress (interrupted or sending), no second send", k2.outcome === "in_progress");
    st = await state(s1);
    t("claimed: stamp still null (claimed ≠ accepted)", st.s.rejection_emailed_at === null && st.n[0].status === "claimed");
    await begin(c, k1.notice_id!);
    await record(c, k1.notice_id!, "failed", null, "Resend 422");
    st = await state(s1);
    t("record failed: stamp null, failed", st.n[0].status === "failed" && st.s.rejection_emailed_at === null);
    await asAdmin(c, admin);
    await moderate(c, s1, "rejected", "Blurry");
    const k3 = await claim(c, s1);
    t("after a definite failure, the same rejection may claim again", k3.outcome === "claimed" && k3.attempt === 2);
    await begin(c, k3.notice_id!);
    await record(c, k3.notice_id!, "accepted", "re_abc");
    st = await state(s1);
    t("record accepted: notice accepted, stamp set", st.n[0].status === "accepted" && st.n[0].accepted_at !== null && st.s.rejection_emailed_at !== null);
    await asAdmin(c, admin);
    t("accepted cannot be reclaimed", (await claim(c, s1)).outcome === "already_accepted");
    t("accepted cannot be recorded again", /NOTICE_NOT_SENDING/.test(await failure(() => record(c, k3.notice_id!, "failed"))));
    t("accepted cannot begin again", /NOTICE_NOT_CLAIMED/.test(await failure(() => begin(c, k3.notice_id!))));
    await asRoot(c);
    t("even the database owner cannot reopen an accepted notice", /NOTICE_(TRANSITION|FINAL)/.test(await failure(() => c.query("update style_rejection_notices set status = 'claimed' where id = $1", [k3.notice_id]))));
    t("…or change its reason", /NOTICE_IMMUTABLE/.test(await failure(() => c.query("update style_rejection_notices set reason_snapshot = 'x' where id = $1", [k3.notice_id]))));
    await asAdmin(c, admin);
    await moderate(c, s1, "rejected", "Blurry");
    st = await state(s1);
    t("repeat moderation does not reset history or the stamp", st.n.length === 1 && st.n[0].status === "accepted" && st.s.rejection_emailed_at !== null);

    // ── Uncertain is never retried ──
    await customer("u");
    const su = await submission("u");
    await asAdmin(c, admin);
    await moderate(c, su, "rejected", "Not the piece");
    const ku = await claim(c, su);
    await begin(c, ku.notice_id!);
    await record(c, ku.notice_id!, "uncertain", null, "timeout");
    await moderate(c, su, "rejected", "Not the piece");
    t("uncertain: never claimed again", (await claim(c, su)).outcome === "uncertain");
    t("uncertain: stamp null", (await state(su)).s.rejection_emailed_at === null);

    // ── Interruption after claim ──
    await customer("i");
    const si = await submission("i");
    await asAdmin(c, admin);
    await moderate(c, si, "rejected", "Too small");
    const ki = await claim(c, si);
    // the "server" dies here: no record call
    await asAdmin(c, admin);
    t("interrupted claim: a later request does not send", ki.outcome === "claimed" && (await claim(c, si)).outcome === "in_progress");

    // ── Silent rejection ──
    await customer("q");
    const sq = await submission("q");
    await asAdmin(c, admin);
    await moderate(c, sq, "rejected", null);
    st = await state(sq);
    t("silent: round 1, no intent", st.s.rejection_round === 1 && st.n.length === 0);
    await asAdmin(c, admin);
    t("silent: claim says silent", (await claim(c, sq)).outcome === "silent");
    t("silent: repeat silent is a no-op", (await failure(() => moderate(c, sq, "rejected", null))) === "" && (await state(sq)).s.rejection_round === 1);

    // ── No recipient ──
    await customer("nomail");
    const sn = await submission("nomail");
    await asRoot(c);
    await c.query("update profiles set email = null where id = $1", [users.nomail]);
    await asAdmin(c, admin);
    await moderate(c, sn, "rejected", "Blurry");
    t("no recipient: reported, notice stays pending", (await claim(c, sn)).outcome === "no_recipient" && (await state(sn)).n[0].status === "pending");

    // ── Resubmission → new cycle → new round ──
    await as(c, "buyer");
    t("customer resubmits (rejected → pending)", (await failure(() => c.query(
      "select resubmit_style($1, null, null, null, 'instagram', 'https://www.instagram.com/p/new/', null, null)", [s1]))) === "");
    st = await state(s1);
    t("resubmission: pending, stamp cleared, accepted history kept", st.s.status === "pending" && st.s.rejection_emailed_at === null && st.n.length === 1 && st.n[0].status === "accepted");
    await asAdmin(c, admin);
    await moderate(c, s1, "rejected", "Still blurry");
    st = await state(s1);
    t("rejecting the resubmission: round 2, new pending intent", st.s.rejection_round === 2 && st.n.length === 2 && st.n[1].round === 2 && st.n[1].status === "pending" && st.n[1].reason_snapshot === "Still blurry");
    await asAdmin(c, admin);
    const k4 = await claim(c, s1);
    t("round 2 is claimable", k4.outcome === "claimed" && k4.round === 2 && k4.reason === "Still blurry");
    await begin(c, k4.notice_id!);
    await record(c, k4.notice_id!, "accepted", "re_2");
    t("round 2 accepted; round 1 still accepted", (await state(s1)).n.every((n) => n.status === "accepted"));

    // ── Approval and back to pending supersede unsent intents ──
    await customer("ap");
    const sa = await submission("ap");
    await asAdmin(c, admin);
    await moderate(c, sa, "rejected", "Wrong piece");
    await c.query("select approve_style($1, null)", [sa]);
    st = await state(sa);
    t("approval after an unsent rejection: intent superseded", st.s.status === "approved" && st.n[0].status === "superseded");
    await asAdmin(c, admin);
    t("…and nothing is claimable", (await claim(c, sa)).outcome === "not_rejected");
    await moderate(c, sa, "pending", null);
    await moderate(c, sa, "rejected", "Wrong piece");
    st = await state(sa);
    t("re-rejecting after approval: a new round, the old intent stays superseded", st.s.rejection_round === 2 && st.n.length === 2 && st.n[0].status === "superseded" && st.n[1].status === "pending");
    await asAdmin(c, admin);
    const kp = await claim(c, sa);
    await begin(c, kp.notice_id!); // handed to the provider
    await moderate(c, sa, "pending", null);
    st = await state(sa);
    t("an in-flight (sending) notice is left alone when it leaves rejected", st.n[1].status === "sending");
    await asAdmin(c, admin);
    await record(c, kp.notice_id!, "accepted", "re_late");
    st = await state(sa);
    t("a late acceptance for a superseded round does not stamp the pending submission", st.n[1].status === "accepted" && st.s.rejection_emailed_at === null);

    // ── Withdrawal ──
    await customer("w");
    const sw = await submission("w");
    await asAdmin(c, admin);
    await moderate(c, sw, "rejected", "Blurry");
    await as(c, "w");
    await c.query("update style_submissions set withdrawn_at = now() where id = $1", [sw]);
    await asAdmin(c, admin);
    t("withdrawn: not emailed", (await claim(c, sw)).outcome === "withdrawn");
    await as(c, "w");
    t("withdrawn: customer cannot resubmit it", (await failure(() => c.query("select resubmit_style($1, null, null, null, 'instagram', 'https://www.instagram.com/p/z/', null, null)", [sw]))) !== "");

    // ── Concurrency (two sessions, real row locks) ──
    await customer("cc");
    const sc = await submission("cc");
    await asAdmin(c, admin);
    await asAdmin(c2, admin);
    await c.query("begin");
    await c2.query("begin");
    await moderate(c, sc, "rejected", "Blurry");
    const second = moderate(c2, sc, "rejected", "Blurry"); // waits on the row lock
    await new Promise((r) => setTimeout(r, 150));
    await c.query("commit");
    await second;
    await c2.query("commit");
    st = await state(sc);
    t("concurrent identical rejections: one round, one intent", st.s.rejection_round === 1 && st.n.length === 1);

    await asAdmin(c, admin);
    await asAdmin(c2, admin);
    await c.query("begin");
    await c2.query("begin");
    const a = claim(c, sc);
    const b = claim(c2, sc);
    const ra = await a;
    await new Promise((r) => setTimeout(r, 150));
    await c.query("commit");
    const rb = await b;
    await c2.query("commit");
    const outcomes = [ra.outcome, rb.outcome].sort();
    t("concurrent claims: exactly one wins", outcomes[0] === "claimed" && outcomes[1] === "in_progress", outcomes.join(","));
    st = await state(sc);
    t("concurrent claims: one attempt counted", st.n[0].attempts === 1 && st.n[0].status === "claimed");

    await customer("cd");
    const sd = await submission("cd");
    await asAdmin(c, admin);
    await asAdmin(c2, admin);
    await c.query("begin");
    await c2.query("begin");
    await moderate(c, sd, "rejected", "Blurry");
    const other = failure(() => moderate(c2, sd, "rejected", "Different"));
    await new Promise((r) => setTimeout(r, 150));
    await c.query("commit");
    const otherErr = await other;
    await c2.query("rollback");
    st = await state(sd);
    t("concurrent different reasons: the second is refused after the first commits", /ALREADY_REJECTED/.test(otherErr) && st.s.reject_reason === "Blurry" && st.n.length === 1);

    // ── Audit: admin visibility of the current round's notice ──
    await asAdmin(c, admin);
    const queue = (await c.query("select admin_style_submissions() q")).rows[0].q as Array<Record<string, unknown>>;
    const q = (id: string) => queue.find((r) => r.id === id)!;
    t("queue: interrupted claim visible as claimed", q(si).rejection_notice_status === "claimed" && q(si).rejection_notice_claimed_at !== null);
    t("queue: uncertain visible", q(su).rejection_notice_status === "uncertain");
    t("queue: pending (no address) visible", q(sn).rejection_notice_status === "pending");
    t("queue: silent rejection has no notice", q(sq).rejection_notice_status === null);
    t("queue: non-rejected rows carry no notice", q(sa).rejection_notice_status === null && q(sa).status === "pending");
    t("queue: still carries the existing fields", "photo_path" in q(si) && "admin_notified_at" in q(si) && "customer_email" in q(si));
    await as(c, "other");
    t("queue: customers still cannot read it", (await failure(() => c.query("select admin_style_submissions()"))) !== "");

    // ── Audit: withdrawal after the email was handed over records the real outcome ──
    await customer("wl");
    const swl = await submission("wl");
    await asAdmin(c, admin);
    await moderate(c, swl, "rejected", "Blurry");
    const kwl = await claim(c, swl);
    await begin(c, kwl.notice_id!);
    await as(c, "wl");
    await c.query("update style_submissions set withdrawn_at = now() where id = $1", [swl]);
    await asAdmin(c, admin);
    await record(c, kwl.notice_id!, "accepted", "re_wl");
    st = await state(swl);
    t("withdrawal after hand-over: the provider's real answer is still recorded", st.n[0].status === "accepted" && st.s.rejection_emailed_at !== null);
    t("…and no further claim is possible", (await claim(c, swl)).outcome === "withdrawn");

    // ── Audit: resubmission after a refused email ──
    await customer("rf");
    const srf = await submission("rf");
    await asAdmin(c, admin);
    await moderate(c, srf, "rejected", "Blurry");
    const krf = await claim(c, srf);
    await begin(c, krf.notice_id!);
    await record(c, krf.notice_id!, "failed", null, "Resend 422");
    await as(c, "rf");
    await c.query("select resubmit_style($1, null, null, null, 'instagram', 'https://www.instagram.com/p/again/', null, null)", [srf]);
    st = await state(srf);
    t("resubmission after a refused email: the old intent is superseded", st.s.status === "pending" && st.n[0].status === "superseded");
    await asAdmin(c, admin);
    t("…and cannot be claimed for the new submission", (await claim(c, srf)).outcome === "not_rejected");

    // ── Audit: a submission deleted after the claim ──
    await customer("dl");
    const sdl = await submission("dl");
    await asAdmin(c, admin);
    await moderate(c, sdl, "rejected", "Blurry");
    const kdl = await claim(c, sdl);
    await asRoot(c);
    await c.query("delete from style_submissions where id = $1", [sdl]);
    await asAdmin(c, admin);
    t("deleted after claim: begin finds nothing to send", (await begin(c, kdl.notice_id!)).send === false);
    t("deleted after claim: recording fails loudly, nothing invented", /NOTICE_NOT_FOUND/.test(await failure(() => record(c, kdl.notice_id!, "accepted", "re_dl"))));
    t("deleted: claim says not_found, nothing sent", (await claim(c, sdl)).outcome === "not_found");
    t("deleted: moderate_style answers false (route → 404)", (await moderate(c, sdl, "rejected", "Blurry")).rows[0].r === false);

    // ══ Post-claim safety (TOCTOU): mocked provider, real database ══
    const providerCalls: string[] = [];
    const okProvider: SendFn = async (m) => {
      providerCalls.push(m.to);
      return { ok: true, id: "re_mock", error: null };
    };
    const fresh = async (key: string) => {
      await customer(key);
      const id = await submission(key);
      await asAdmin(c, admin);
      await moderate(c, id, "rejected", "Blurry");
      return { id, k: await claim(c, id) };
    };

    // 1. Claim → customer withdraws → send begins.
    {
      const { id, k } = await fresh("t1");
      await as(c2, "t1");
      await c2.query("update style_submissions set withdrawn_at = now() where id = $1", [id]);
      await asAdmin(c, admin);
      const before = providerCalls.length;
      const r = await sendClaimedRejection(k, realDeps(c, okProvider));
      st = await state(id);
      t("claim → withdraw → send: NOT sent", providerCalls.length === before && r.status === "skipped" && /withdrawn/.test(r.message));
      t("…recorded as skipped (withdrawn), stamp null", st.n[0].status === "skipped" && st.s.rejection_emailed_at === null);
      const after = (await rd.query("select last_error from style_rejection_notices where id = $1", [k.notice_id])).rows[0].last_error;
      t("…with the reason kept", after === "skipped: withdrawn", after);
      await asAdmin(c, admin);
      t("…and it cannot be claimed again", (await claim(c, id)).outcome === "withdrawn");
    }
    // 2. Claim → customer resubmits → send begins.
    {
      const { id, k } = await fresh("t2");
      await as(c2, "t2");
      await c2.query("select resubmit_style($1, null, null, null, 'instagram', 'https://www.instagram.com/p/t2/', null, null)", [id]);
      await asAdmin(c, admin);
      const before = providerCalls.length;
      const r = await sendClaimedRejection(k, realDeps(c, okProvider));
      st = await state(id);
      t("claim → resubmit → send: NOT sent", providerCalls.length === before && r.status === "skipped" && /no longer turned down/.test(r.message));
      t("…notice skipped (not superseded: it had been claimed)", st.n[0].status === "skipped" && st.s.status === "pending");
    }
    // 3. Claim → admin moves it back to pending → send begins.
    {
      const { id, k } = await fresh("t3");
      await asAdmin(c2, admin);
      await moderate(c2, id, "pending", null);
      const before = providerCalls.length;
      const r = await sendClaimedRejection(k, realDeps(c, okProvider));
      t("claim → back to pending → send: NOT sent", providerCalls.length === before && r.status === "skipped" && (await state(id)).n[0].status === "skipped");
    }
    // 3b. Claim → pending → rejected again (a new round) → the OLD claim begins.
    {
      const { id, k } = await fresh("t3b");
      await asAdmin(c2, admin);
      await moderate(c2, id, "pending", null);
      await moderate(c2, id, "rejected", "Different now");
      const before = providerCalls.length;
      const r = await sendClaimedRejection(k, realDeps(c, okProvider));
      st = await state(id);
      t("stale claim from an earlier round: NOT sent", providerCalls.length === before && r.status === "skipped" && st.n[0].status === "skipped");
      t("…the new round's intent is untouched and claimable", st.n[1].status === "pending" && (await claim(c, id)).outcome === "claimed");
    }
    // 4. Claim → handed over → customer withdraws / resubmits → provider answers.
    for (const [label, change, expectStamp] of [
      ["withdraws", "withdraw", true],
      ["resubmits", "resubmit", false],
    ] as const) {
      const { id, k } = await fresh(`t4${change}`);
      const duringSend: SendFn = async (m) => {
        providerCalls.push(m.to);
        await as(c2, `t4${change}`);
        if (change === "withdraw") await c2.query("update style_submissions set withdrawn_at = now() where id = $1", [id]);
        else await c2.query("select resubmit_style($1, null, null, null, 'instagram', 'https://www.instagram.com/p/x/', null, null)", [id]);
        return { ok: true, id: "re_during", error: null };
      };
      const r = await sendClaimedRejection(k, realDeps(c, duringSend));
      st = await state(id);
      t(`handed over → customer ${label} → accepted: recorded truthfully as accepted`, r.status === "accepted" && st.n[0].status === "accepted");
      t(`…stamp ${expectStamp ? "set (still rejected, same round)" : "NOT set (no longer rejected)"}`, (st.s.rejection_emailed_at !== null) === expectStamp);
    }
    {
      const { id, k } = await fresh("t4u");
      const duringSend: SendFn = async () => {
        await as(c2, "t4u");
        await c2.query("update style_submissions set withdrawn_at = now() where id = $1", [id]);
        return { ok: false, id: null, error: "Resend 503" };
      };
      const r = await sendClaimedRejection(k, realDeps(c, duringSend));
      t("handed over → withdraws → 503: stays UNCERTAIN, never turned into failed", r.status === "uncertain" && (await state(id)).n[0].status === "uncertain");
    }
    {
      const { id, k } = await fresh("t4t");
      const r = await sendClaimedRejection(k, { ...realDeps(c, () => new Promise(() => {})), timeoutMs: 50 });
      t("handed over → timeout: uncertain", r.status === "uncertain" && (await state(id)).n[0].status === "uncertain");
    }
    // One claim can begin at most one send.
    {
      const { k } = await fresh("t5");
      await asAdmin(c, admin);
      t("begin once: sending", (await begin(c, k.notice_id!)).send === true);
      t("begin twice: refused", /NOTICE_NOT_CLAIMED/.test(await failure(() => begin(c, k.notice_id!))));
      const k5b = (await fresh("t5b")).k;
      t("record needs a begun send (claimed alone refused)", /NOTICE_NOT_SENDING/.test(await failure(() => record(c, k5b.notice_id!, "accepted"))));
      await asRoot(c);
      t("owner cannot move sending back to claimed", /NOTICE_TRANSITION/.test(await failure(() => c.query("update style_rejection_notices set status = 'claimed' where id = $1", [k.notice_id]))));
      await asAdmin(c, admin);
    }
    // Concurrency at the last check (two sessions, real row locks).
    {
      // a) The withdrawal commits first: begin waits for it, then skips.
      const { id, k } = await fresh("t6a");
      await as(c2, "t6a");
      await c2.query("begin");
      await c2.query("update style_submissions set withdrawn_at = now() where id = $1", [id]);
      await asAdmin(c, admin);
      const pending = begin(c, k.notice_id!);
      await new Promise((r) => setTimeout(r, 150));
      await c2.query("commit");
      t("withdrawal commits before the last check: begin waits, then skips", (await pending).send === false);
    }
    {
      // b) The last check commits first: the withdrawal waits; the send goes
      //    ahead. This is the residual race, shown rather than hidden.
      const { id, k } = await fresh("t6b");
      await asAdmin(c, admin);
      await c.query("begin");
      const b = await begin(c, k.notice_id!);
      await as(c2, "t6b");
      const withdrawal = c2.query("update style_submissions set withdrawn_at = now() where id = $1", [id]);
      await new Promise((r) => setTimeout(r, 150));
      await c.query("commit");
      await withdrawal;
      t("last check commits first: it was eligible then, so the send proceeds (residual race)", b.send === true && (await state(id)).n[0].status === "sending");
    }
    // Queue labels for the new states.
    await asAdmin(c, admin);
    {
      const qq = (await c.query("select admin_style_submissions() q")).rows[0].q as Array<Record<string, unknown>>;
      const statuses = new Set(qq.map((r) => r.rejection_notice_status));
      t("queue: skipped and sending visible to admins", statuses.has("skipped") && statuses.has("sending"));
    }

    // ── Account deletion ──
    await asRoot(c);
    const before = (await c.query("select count(*)::int n from style_rejection_notices where submission_id = $1", [s1])).rows[0].n;
    await as(c, "buyer");
    const del = await failure(() => c.query("select delete_my_account()"));
    await asRoot(c);
    const after = (await c.query("select count(*)::int n from style_rejection_notices where submission_id = $1", [s1])).rows[0].n;
    const leftover = (await c.query("select count(*)::int n from style_rejection_notices where recipient_email = 'buyer@example.test'")).rows[0].n;
    t("account deletion removes the submission's notices and the address", del === "" && before === 2 && after === 0 && leftover === 0, `${del} ${before}→${after}`);
    t("other customers' notices untouched", (await c.query("select count(*)::int n from style_rejection_notices")).rows[0].n > 0);

    // ── Posture ──
    const priv = (await c.query(`select
        has_table_privilege('anon', 'public.style_rejection_notices', 'SELECT') anon_sel,
        has_table_privilege('authenticated', 'public.style_rejection_notices', 'UPDATE') auth_upd,
        has_table_privilege('authenticated', 'public.style_rejection_notices', 'DELETE') auth_del,
        has_table_privilege('service_role', 'public.style_rejection_notices', 'INSERT') svc_ins,
        has_column_privilege('authenticated', 'public.style_submissions', 'rejection_emailed_at', 'UPDATE') stamp_upd,
        has_function_privilege('anon', 'public.record_style_rejection_notice(uuid,text,text,text)', 'EXECUTE') anon_rec`)).rows[0];
    t("privileges: anon nothing, customers read-only (RLS: admins), service_role read-only, stamp not customer-writable",
      !priv.anon_sel && !priv.auth_upd && !priv.auth_del && !priv.svc_ins && !priv.stamp_upd && !priv.anon_rec, JSON.stringify(priv));

    await c.end();
    await c2.end();
    await rd.end();
  } finally {
    await engine.stop();
  }
  return true;
}

(async () => {
  await unit();
  const db = await database();
  console.log(`\nstyle-rejection-notice: ${pass} passed, ${fail} failed${db ? "" : " (DB SKIPPED — migration NOT verified)"}`);
  process.exit(fail ? 1 : db ? 0 : 2);
})();
