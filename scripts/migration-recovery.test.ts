/**
 * Guarded recovery for migrations 0074, 0075 and 0076 (supabase/recovery/),
 * rehearsed on real PostgreSQL 17.6 (embedded, via scripts/pg-world).
 *
 *   PG_HARNESS_DIR=<dir with embedded-postgres@17.6.0-beta.15> npx tsx scripts/migration-recovery.test.ts
 *
 * Every rollback runs through scripts/run-recovery-sql.mjs (the runbook's
 * tool), against localhost only. Nothing reads .env.local or reaches a remote
 * database. Without the harness, or on a checkout that does not yet contain
 * 0074–0076, the suite reports SKIPPED (exit 2), never passed.
 *
 *   A. 0076: safe rollback == 0075; re-apply == clean 0076; refusals.
 *   B. 0075: safe rollback == 0074 (dispatched orders kept); refusals.
 *   C. 0074: safe rollback == 0073 (orders and claims kept); refusals.
 *   D. The chain: 0074 → 0075 → 0076 up, 0076 → 0075 → 0074 down == 0073
 *      (catalog snapshot + security posture + committed manifest), up again
 *      == clean 0076; out-of-order rollbacks refused.
 * A rehearsal on replayed migrations says nothing about Production's actual
 * state: the runbook's preflight (posture MATCH, backup) covers that.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { asAdmin, asRoot, asService, asStaffPasswordOnly, asUser, failure, makeAdmin, startEngine, type Client } from "./pg-world";
import { comparePostures, readPosture } from "./security-posture";

const ROOT = path.join(__dirname, "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const RECOVERY = path.join(ROOT, "supabase", "recovery");
const RUNNER = path.join(__dirname, "run-recovery-sql.mjs");
const M74 = "0074_order_confirmation_deliveries.sql";
const M75 = "0075_order_dispatch.sql";
const M76 = "0076_style_rejection_notices.sql";
const MIG = (f: string) => fs.readFileSync(path.join(MIGRATIONS, f), "utf8");
const ROLLBACK = {
  "0074": process.env.ROLLBACK_0074 ?? path.join(RECOVERY, "0074_rollback.sql"),
  "0075": process.env.ROLLBACK_0075 ?? path.join(RECOVERY, "0075_rollback.sql"),
  "0076": process.env.ROLLBACK_0076 ?? path.join(RECOVERY, "0076_rollback.sql"),
};
// The posture of main before any email work (0073), as committed.
const MANIFEST_0073_COMMIT = "76aa2d8";

let pass = 0;
let fail = 0;
let skipped = 0;
const t = (name: string, ok: boolean, detail = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  — ${detail.slice(0, 600)}`}`);
};
const skip = (name: string, why: string) => {
  skipped++;
  console.log(`  SKIP  ${name} — ${why}`);
};

// ── Catalog snapshot: everything a rollback must restore ──
async function snapshot(c: Client) {
  const q = async (sql: string) => (await c.query(sql)).rows;
  const pub = "(select oid from pg_class where relnamespace = 'public'::regnamespace)";
  return {
    columns: await q(`select table_name, column_name, data_type, is_nullable, column_default
                        from information_schema.columns where table_schema = 'public' order by 1, 2`),
    constraints: await q(`select conrelid::regclass::text t, conname, pg_get_constraintdef(oid) d
                            from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2`),
    indexes: await q(`select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by 1, 2`),
    functions: await q(`select p.oid::regprocedure::text f, md5(pg_get_functiondef(p.oid)) def, p.proacl::text acl,
                               obj_description(p.oid, 'pg_proc') cmt
                          from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p') order by 1`),
    triggers: await q(`select tgrelid::regclass::text t, tgname, tgenabled, pg_get_triggerdef(oid) d
                         from pg_trigger where not tgisinternal and tgrelid in ${pub} order by 1, 2`),
    policies: await q(`select tablename, policyname, permissive, roles::text, cmd, qual, with_check
                         from pg_policies where schemaname = 'public' order by 1, 2`),
    relations: await q(`select relname, relkind, relacl::text acl, relrowsecurity, relforcerowsecurity,
                               obj_description(oid, 'pg_class') cmt
                          from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'v', 'm', 'S', 'p', 'i') order by 1`),
    columnAcls: await q(`select attrelid::regclass::text t, attname, attacl::text acl from pg_attribute
                          where attacl is not null and not attisdropped and attrelid in ${pub} order by 1, 2`),
    columnComments: await q(`select c.relname, a.attname, col_description(c.oid, a.attnum) cmt
                               from pg_class c join pg_attribute a on a.attrelid = c.oid
                              where c.relnamespace = 'public'::regnamespace and a.attnum > 0 and not a.attisdropped
                                and col_description(c.oid, a.attnum) is not null order by 1, 2`),
  };
}
type Snap = Awaited<ReturnType<typeof snapshot>>;
function diff(a: Snap, b: Snap): string {
  const out: string[] = [];
  for (const k of Object.keys(a) as (keyof Snap)[]) {
    const A = new Set(a[k].map((r) => JSON.stringify(r)));
    const B = new Set(b[k].map((r) => JSON.stringify(r)));
    for (const x of A) if (!B.has(x)) out.push(`- ${k} ${x.slice(0, 200)}`);
    for (const x of B) if (!A.has(x)) out.push(`+ ${k} ${x.slice(0, 200)}`);
  }
  return out.join("\n");
}
const posture = async (c: Client) => (await readPosture(c)).posture;

async function main() {
  for (const f of [M74, M75, M76]) {
    if (!fs.existsSync(path.join(MIGRATIONS, f))) {
      console.log(`=== SKIPPED — ${f} is not in this checkout (the recovery scripts target 0074–0076). NOT a pass. ===`);
      process.exit(2);
    }
  }
  const engine = await startEngine();
  if (!engine) {
    console.log("=== DATABASE: SKIPPED — embedded-postgres not found (set PG_HARNESS_DIR). NOT a pass. ===");
    process.exit(2);
  }
  t("harness is PostgreSQL 17.6", /PostgreSQL 17\.6/.test(engine.version), engine.version);
  const conns: Client[] = [];
  const open = async (db: string) => {
    const c = await engine.connect(db);
    conns.push(c);
    await asRoot(c);
    return c;
  };
  const port = async (c: Client) => (await c.query("select inet_server_port() p")).rows[0].p as number;
  const run = async (which: keyof typeof ROLLBACK, c: Client, db: string, extra = ["--expect-host", "localhost", "--i-have-a-verified-backup"],
                     opts: { env?: Record<string, string>; envFile?: string; file?: string } = {}) => {
    // The runner reads its target from ./.env.local only (scripts/lib/db-target.mjs),
    // so each run gets a temp working directory holding one, and an environment
    // with nothing inherited that could name a database.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-run-"));
    fs.writeFileSync(path.join(cwd, ".env.local"), opts.envFile ?? `SUPABASE_DB_URL=postgres://postgres:throwaway@localhost:${await port(c)}/${db}\n`);
    try {
      const out = execFileSync("node", [RUNNER, opts.file ?? ROLLBACK[which], ...extra], {
        cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
          ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
          ...(process.env.A3_NETGUARD_LOG ? { A3_NETGUARD_LOG: process.env.A3_NETGUARD_LOG } : {}),
          ...opts.env,
        } as unknown as NodeJS.ProcessEnv,
      });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string };
      return { code: err.status, out: `${err.stdout}${err.stderr}` };
    }
  };
  const ledger = async (c: Client, f: string) =>
    (await c.query("select count(*)::int n from schema_migrations where filename = $1", [f])).rows[0].n as number;
  // As scripts/run-migration.mjs applies a file: the SQL, then the ledger row.
  const apply = async (c: Client, f: string) => {
    await c.query(MIG(f));
    await c.query("insert into schema_migrations (filename) values ($1) on conflict (filename) do nothing", [f]);
  };
  const orders = async (c: Client) =>
    JSON.stringify((await c.query(`select id, status, payment_status, payment_provider, shipped_at, courier_name, awb_number,
                                          confirmation_sent_at, customer_email, total_inr, invoice_number from orders order by id`)).rows);
  const deliveries = async (c: Client) =>
    (await c.query("select to_regclass('public.order_email_deliveries') is not null e")).rows[0].e
      ? JSON.stringify((await c.query("select * from order_email_deliveries order by id")).rows) : "[]";

  try {
    // ══ Baselines ═════════════════════════════════════════════════════════
    console.log("\n=== baselines (clean forward replays) ===");
    const S: Record<string, Snap> = {};
    const P: Record<string, unknown> = {};
    for (const m of ["0073", "0074", "0075", "0076"]) {
      await engine.database(`b${m}`, m);
      const c = await open(`b${m}`);
      S[m] = await snapshot(c);
      P[m] = await posture(c);
    }
    t("each of 0074, 0075, 0076 changes the catalog (sanity)", !!diff(S["0073"], S["0074"]) && !!diff(S["0074"], S["0075"]) && !!diff(S["0075"], S["0076"]));
    let manifest73: unknown = null;
    try {
      manifest73 = JSON.parse(execFileSync("git", ["show", `${MANIFEST_0073_COMMIT}:supabase/security-posture.json`], { cwd: ROOT, encoding: "utf8" }));
      const d = comparePostures(manifest73, P["0073"]);
      t(`clean 0073 replay MATCHES the committed manifest at ${MANIFEST_0073_COMMIT}`, d.length === 0, d.join("; "));
    } catch {
      skip("0073 manifest comparison", `git object ${MANIFEST_0073_COMMIT} not available in this checkout`);
    }
    // The manifests the runbook names for each intermediate state.
    for (const [m, commit] of [["0074", "04c230c"], ["0075", "f73c1d6"]] as const) {
      try {
        const man = JSON.parse(execFileSync("git", ["show", `${commit}:supabase/security-posture.json`], { cwd: ROOT, encoding: "utf8" }));
        const d = comparePostures(man, P[m]);
        t(`clean ${m} replay MATCHES the committed manifest at ${commit} (named in the README)`, d.length === 0, d.join("; "));
      } catch {
        skip(`${m} manifest comparison`, `git object ${commit} not available in this checkout`);
      }
    }
    const manifestHere = JSON.parse(fs.readFileSync(path.join(ROOT, "supabase", "security-posture.json"), "utf8"));
    const dHere = comparePostures(manifestHere, P["0076"]);
    t("clean 0076 replay MATCHES this checkout's security-posture.json", dHere.length === 0, dHere.join("; "));

    // A realistic world: customers, orders, an admin.
    const seedOrders = async (c: Client) => {
      const P0 = (await c.query("insert into products (name, slug, price_inr) values ('Saree', 'saree-' || floor(random() * 1e9), 1000) returning id")).rows[0].id;
      const addr = JSON.stringify({ line1: "12 Beach Road", city: "Alappuzha", state: "Kerala", postal_code: "688001", country: "India" });
      const items = JSON.stringify([{ id: P0, name: "Saree", quantity: 1, price_inr: 1000 }]);
      const mk = async (provider: string, status: string, claimed: boolean, email: string | null = "c@example.test") =>
        (await c.query(
          `insert into orders (customer_email, total_inr, items, payment_status, payment_provider, status, shipping_address, confirmation_sent_at)
           values ($1, 1000, $2::jsonb, 'paid', $3, $4, $5::jsonb, $6) returning id`,
          [email, items, provider, status, addr, claimed ? new Date().toISOString() : null])).rows[0].id as string;
      return {
        // Claimed by the pre-R1 application (0058): must survive every rollback.
        oldConfirmed: await mk("razorpay", "confirmed", true),
        online: await mk("razorpay", "confirmed", false),
        online2: await mk("razorpay", "confirmed", false),
        noEmail: await mk("razorpay", "confirmed", false, null),
        inPerson: await mk("offline", "confirmed", true),
      };
    };
    const reject = async (r: { code: number; out: string }, re: RegExp) => r.code === 1 && re.test(r.out);
    const unchanged = async (c: Client, before: { s: Snap; o: string; d: string; l: number[] }) => {
      const now = { s: await snapshot(c), o: await orders(c), d: await deliveries(c), l: [await ledger(c, M74), await ledger(c, M75), await ledger(c, M76)] };
      return diff(before.s, now.s) === "" && before.o === now.o && before.d === now.d && JSON.stringify(before.l) === JSON.stringify(now.l);
    };
    const state = async (c: Client) => ({ s: await snapshot(c), o: await orders(c), d: await deliveries(c), l: [await ledger(c, M74), await ledger(c, M75), await ledger(c, M76)] });

    // ══ A. 0076 ═══════════════════════════════════════════════════════════
    console.log("\n=== A. 0076 rollback (style rejection notices) ===");
    {
      await engine.database("a", "0075");
      const c = await open("a");
      const P0 = (await c.query("insert into products (name, slug, price_inr) values ('Saree', 'saree', 1000) returning id")).rows[0].id;
      const user = async (email: string) => {
        const id = (await c.query("insert into auth.users (email) values ($1) returning id", [email])).rows[0].id as string;
        await c.query("insert into profiles (id, email, full_name) values ($1, $2, 'Customer') on conflict (id) do update set email = $2", [id, email]);
        return id;
      };
      const sub = async (u: string, status: string, reason: string | null, stamp: string | null) =>
        (await c.query(`insert into style_submissions (product_id, user_id, video_platform, video_url, consented_at, status, reject_reason, rejection_emailed_at)
                        values ($1, $2, 'instagram', 'https://www.instagram.com/p/abc/', now(), $3, $4, $5) returning id`,
          [P0, u, status, reason, stamp])).rows[0].id as string;
      const u = { emailed: await user("e@example.test"), pending: await user("p@example.test") };
      const ids = { emailed: await sub(u.emailed, "rejected", "Blurry", "2026-10-20T10:00:00Z"), pending: await sub(u.pending, "pending", null, null) };
      const subs = async () => JSON.stringify((await c.query("select id, status, reject_reason, rejection_emailed_at, withdrawn_at from style_submissions order by id")).rows);
      const before = await subs();
      await apply(c, M76);
      t("0076 on a 0075 database with history == clean 0076", diff(S["0076"], await snapshot(c)) === "");
      const wrong = await run("0076", c, "a", ["--expect-host", "db.example.supabase.co", "--i-have-a-verified-backup"]);
      t("runner refuses an unexpected host (nothing runs)", wrong.code === 2 && /Refusing: host is localhost/.test(wrong.out));
      const nob = await run("0076", c, "a", ["--expect-host", "localhost"]);
      t("runner refuses without --i-have-a-verified-backup", nob.code === 2 && /verify a backup first/.test(nob.out));
      // The shared target rule (scripts/lib/db-target.mjs). Every refusal: exit 2, before
      // connecting, 0076 still applied. The hostile host is fake and never resolvable.
      const HOSTILE = "postgresql://postgres:hostile-secret@hostile.example.invalid:5432/postgres";
      const pgp = await port(c);
      const refusedBefore = async (name: string, r: { code: number; out: string }, re: RegExp) =>
        t(name, r.code === 2 && re.test(r.out) && !/hostile-secret|throwaway/.test(r.out) && (await ledger(c, M76)) === 1, `${r.code} ${r.out}`);
      await refusedBefore("runner refuses a differing exported SUPABASE_DB_URL (R-4)",
        await run("0076", c, "a", undefined, { env: { SUPABASE_DB_URL: HOSTILE } }), /differs from \.env\.local/);
      await refusedBefore("runner refuses inherited PGHOST/PGPASSWORD",
        await run("0076", c, "a", undefined, { env: { PGHOST: "hostile.example.invalid", PGPASSWORD: "hostile-secret" } }), /inherited PostgreSQL variables are set \(PGHOST, PGPASSWORD\)/);
      await refusedBefore("runner refuses a ?host= override in the URL",
        await run("0076", c, "a", undefined, { envFile: `SUPABASE_DB_URL=postgres://postgres:throwaway@localhost:${pgp}/a?host=hostile.example.invalid\n` }), /query parameters \(host\)/);
      await refusedBefore("runner refuses SUPABASE_DB_URL defined twice in .env.local",
        await run("0076", c, "a", undefined, { envFile: `SUPABASE_DB_URL=postgres://postgres:throwaway@localhost:${pgp}/a\nSUPABASE_DB_URL=${HOSTILE}\n` }), /defined 2 times/);
      await refusedBefore("runner refuses an .env.local host that differs from --expect-host",
        await run("0076", c, "a", undefined, { envFile: `SUPABASE_DB_URL=${HOSTILE}\n` }), /host is hostile\.example\.invalid, expected localhost/);
      await refusedBefore("runner refuses --expect-host with no value",
        await run("0076", c, "a", ["--i-have-a-verified-backup", "--expect-host"]), /--expect-host needs a host/);
      await refusedBefore("runner refuses an unknown option",
        await run("0076", c, "a", ["--expect-host", "localhost", "--i-have-a-verified-backup", "--force"]), /unknown option\(s\) --force/);
      await refusedBefore("runner refuses a migration file (no bypass of run-migration.mjs)",
        await run("0076", c, "a", undefined, { file: path.join(MIGRATIONS, M76) }), /not a recovery file of this runner/);
      const stray = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stray-")), "0076_rollback.sql");
      fs.copyFileSync(ROLLBACK["0076"], stray);
      await refusedBefore("runner refuses a recovery-named file outside its own supabase/recovery/",
        await run("0076", c, "a", undefined, { file: stray }), /not a recovery file of this runner/);
      const r = await run("0076", c, "a");
      t("safe rollback succeeds", r.code === 0 && /ROLLED BACK 0076/.test(r.out), r.out);
      t("catalog == clean 0075", diff(S["0075"], await snapshot(c)) === "", diff(S["0075"], await snapshot(c)));
      t("security posture == clean 0075", comparePostures(P["0075"], await posture(c)).length === 0);
      t("submissions unchanged; 0076 ledger row gone", (await subs()) === before && (await ledger(c, M76)) === 0);
      const admin = await makeAdmin(c, "admin-a@example.test");
      const w = await open("a");
      await asAdmin(w, admin);
      t("restored 0052 moderation works for a two-factor admin", (await w.query("select moderate_style($1, 'rejected', 'Out of focus') r", [ids.pending])).rows[0].r === true);
      await asStaffPasswordOnly(w, admin);
      t("MFA kept: password-only admin cannot moderate", /Only admins/.test(await failure(() => w.query("select moderate_style($1, 'approved', null)", [ids.pending]))));
      await w.query("set role anon");
      t("anon cannot execute moderate_style", /permission denied/.test(await failure(() => w.query("select moderate_style($1, 'approved', null)", [ids.pending]))));
      await asUser(w, u.emailed, "aal1");
      t("customer cannot change status", /permission denied/.test(await failure(() => w.query("update style_submissions set status = 'approved' where id = $1", [ids.emailed]))));
      t("customer can write their own stamp again (exact pre-0076 posture, documented)",
        (await w.query("update style_submissions set rejection_emailed_at = rejection_emailed_at where id = $1", [ids.emailed])).rowCount === 1);
      await asRoot(w);
      await c.query("update style_submissions set status = 'pending', reject_reason = null, rejection_emailed_at = null where id = $1", [ids.pending]);
      await apply(c, M76);
      t("re-apply == clean 0076 (catalog and posture)", diff(S["0076"], await snapshot(c)) === "" && comparePostures(P["0076"], await posture(c)).length === 0);

      // Refusals, each on its own database with real post-0076 activity.
      const scen = async (name: string, act: (w: Client, ids: Record<string, string>, admin: string) => Promise<void>, re: RegExp) => {
        const db = `a_${name}`;
        await engine.database(db, "0075");
        const d = await open(db);
        const P1 = (await d.query("insert into products (name, slug, price_inr) values ('S', 's', 1) returning id")).rows[0].id;
        const mkU = async (e: string) => {
          const id = (await d.query("insert into auth.users (email) values ($1) returning id", [e])).rows[0].id;
          await d.query("insert into profiles (id, email, full_name) values ($1, $2, 'C') on conflict (id) do update set email = $2", [id, e]);
          return id;
        };
        const mkS = async (uid: string, status: string, reason: string | null, stamp: string | null) =>
          (await d.query(`insert into style_submissions (product_id, user_id, video_platform, video_url, consented_at, status, reject_reason, rejection_emailed_at)
                          values ($1, $2, 'instagram', 'https://www.instagram.com/p/x/', now(), $3, $4, $5) returning id`, [P1, uid, status, reason, stamp])).rows[0].id;
        const sIds = {
          emailed: await mkS(await mkU("e1@example.test"), "rejected", "Blurry", "2026-10-20T10:00:00Z"),
          silent: await mkS(await mkU("s1@example.test"), "rejected", null, null),
          pending: await mkS(await mkU("p1@example.test"), "pending", null, null),
        };
        await apply(d, M76);
        const adm = await makeAdmin(d, `adm-${name}@example.test`);
        const w2 = await open(db);
        await asAdmin(w2, adm);
        await act(w2, sIds, adm);
        await asRoot(w2);
        const notices = async () => JSON.stringify((await d.query("select * from style_rejection_notices order by id")).rows);
        const b = { s: await snapshot(d), n: await notices(), x: JSON.stringify((await d.query("select * from style_submissions order by id")).rows) };
        const rr = await run("0076", d, db);
        t(`0076 ${name}: refused`, await reject(rr, re), rr.out);
        t(`0076 ${name}: nothing changed`, diff(b.s, await snapshot(d)) === "" && b.n === (await notices())
          && b.x === JSON.stringify((await d.query("select * from style_submissions order by id")).rows) && (await ledger(d, M76)) === 1);
      };
      const rej = (w: Client, id: string, reason: string | null) => w.query("select moderate_style($1, 'rejected', $2)", [id, reason]);
      const claimSend = async (w: Client, id: string, outcome: string | null) => {
        const cl = (await w.query("select claim_style_rejection_notice($1) c", [id])).rows[0].c;
        if (outcome === null) return;
        await w.query("select begin_style_rejection_send($1)", [cl.notice_id]);
        await w.query("select record_style_rejection_notice($1, $2, $3, $4)", [cl.notice_id, outcome, outcome === "accepted" ? "re_1" : null, outcome === "accepted" ? null : "x"]);
      };
      await scen("pending_intent", async (w, i) => { await rej(w, i.pending, "Retake"); }, /\(R1\)/);
      await scen("accepted", async (w, i) => { await rej(w, i.pending, "Retake"); await claimSend(w, i.pending, "accepted"); }, /\(R1\)/);
      await scen("uncertain", async (w, i) => { await rej(w, i.pending, "Retake"); await claimSend(w, i.pending, "uncertain"); }, /\(R1\)/);
      await scen("failed", async (w, i) => { await rej(w, i.pending, "Retake"); await claimSend(w, i.pending, "failed"); }, /\(R1\)/);
      await scen("in_flight", async (w, i) => { await rej(w, i.pending, "Retake"); await claimSend(w, i.pending, null); }, /\(R1\)/);
      await scen("superseded", async (w, i) => { await rej(w, i.pending, "Retake"); await w.query("select moderate_style($1, 'pending', null)", [i.pending]); }, /\(R1\)/);
      await scen("backfill_moved_on", async (w, i) => { await w.query("select moderate_style($1, 'pending', null)", [i.emailed]); }, /\(R2\)/);
      await scen("silent_rounds", async (w, i) => { await rej(w, i.pending, null); await w.query("select moderate_style($1, 'pending', null)", [i.pending]); await rej(w, i.pending, null); }, /\(R3\)/);
      await scen("approved_after_rejection", async (w, i) => { await w.query("select moderate_style($1, 'approved', null)", [i.silent]); }, /\(R3\)/);
      const b75 = await open("b0075");
      const na = await run("0076", b75, "b0075");
      t("0076 rollback on a database without 0076: refused, unchanged", await reject(na, /0076 is not \(fully\) applied/) && diff(S["0075"], await snapshot(b75)) === "");
    }

    // ══ B. 0075 ═══════════════════════════════════════════════════════════
    console.log("\n=== B. 0075 rollback (dispatch) ===");
    {
      // Safe: in-person dispatch (no email row) and confirmation rows from 0074.
      await engine.database("b", "0075");
      const c = await open("b");
      const o = await seedOrders(c);
      const admin = await makeAdmin(c, "admin-b@example.test");
      const w = await open("b");
      await asAdmin(w, admin);
      const disp = (await w.query("select dispatch_order($1, 'india_post_speed_post', 'EE123456785IN', true) r", [o.inPerson])).rows[0].r;
      t("setup: in-person order dispatched with no email row", disp.outcome === "dispatched" && disp.delivery_id === null);
      t("setup: the guard refuses a direct 'shipped' before rollback",
        /dispatching them/.test(await failure(() => w.query("update orders set status = 'shipped' where id = $1", [o.online2]))));
      await asService(w);
      const enq = (await w.query("select * from enqueue_order_confirmation($1)", [o.online])).rows[0];
      t("setup: a confirmation row (0074 data) exists", enq.created === true);
      await asRoot(w);
      await c.query("insert into schema_migrations (filename) values ($1), ($2) on conflict do nothing", [M74, M75]);
      const before = { o: await orders(c), d: await deliveries(c) };

      const with76 = await open("b0076");
      await with76.query("insert into schema_migrations (filename) values ($1) on conflict do nothing", [M76]);
      const s76 = await state(with76);
      const r76 = await run("0075", with76, "b0076");
      t("0075 rollback while 0076 is applied: refused (P2), unchanged", await reject(r76, /\(P2\): 0076 is still applied/) && await unchanged(with76, s76));
      const b74 = await open("b0074");
      const s74 = await state(b74);
      t("0075 rollback without 0075: refused (P1), unchanged", await reject(await run("0075", b74, "b0074"), /\(P1\)/) && await unchanged(b74, s74));

      const r = await run("0075", c, "b");
      t("safe rollback succeeds (in-person dispatch + confirmation rows present)", r.code === 0 && /ROLLED BACK 0075/.test(r.out), r.out);
      t("catalog == clean 0074", diff(S["0074"], await snapshot(c)) === "", diff(S["0074"], await snapshot(c)));
      t("security posture == clean 0074", comparePostures(P["0074"], await posture(c)).length === 0);
      t("every order kept exactly, incl. the dispatched one's status, shipped_at, courier and consignment", (await orders(c)) === before.o);
      t("confirmation delivery rows kept exactly", (await deliveries(c)) === before.d);
      t("0075 ledger row gone, 0074's kept", (await ledger(c, M75)) === 0 && (await ledger(c, M74)) === 1);
      await asAdmin(w, admin);
      t("pre-E3 behaviour back: a two-factor admin marks an order shipped directly",
        (await w.query("update orders set status = 'shipped', courier_name = 'India Post', awb_number = 'EE1' where id = $1", [o.online2])).rowCount === 1);
      await asStaffPasswordOnly(w, admin);
      t("MFA kept: a password-only admin session changes no order",
        (await w.query("update orders set admin_note = 'x' where id = $1", [o.online2]).then((x) => x.rowCount, () => 0)) === 0);
      await w.query("set role anon");
      t("anon still cannot update orders", /permission denied/.test(await failure(() => w.query("update orders set status = 'shipped'"))));
      await asRoot(w);

      // Refusals with shipping-email evidence in every state.
      const scen = async (name: string, act: (c: Client, w: Client, o: Record<string, string>, admin: string) => Promise<void>, re: RegExp) => {
        const db = `b_${name}`;
        await engine.database(db, "0075");
        const d = await open(db);
        const oo = await seedOrders(d);
        const adm = await makeAdmin(d, `adm-b-${name}@example.test`);
        const ww = await open(db);
        await asAdmin(ww, adm);
        await act(d, ww, oo, adm);
        await asRoot(ww);
        const s = await state(d);
        const rr = await run("0075", d, db);
        t(`0075 ${name}: refused`, await reject(rr, re), rr.out);
        t(`0075 ${name}: nothing changed (catalog, orders, deliveries, ledger)`, await unchanged(d, s));
      };
      const dispatch = (w: Client, id: string) => w.query("select dispatch_order($1, 'india_post_speed_post', 'EE123456785IN', true)", [id]);
      // Rows advanced by the database owner (the only role that can), to reach each state.
      const setStatus = (d: Client, sql: string) => d.query(`update order_email_deliveries set ${sql} where kind = 'shipment_notification'`);
      await scen("shipment_pending", async (_d, w, oo) => { await dispatch(w, oo.online); }, /\(R1\): shipping-email records exist \(pending:1\)/);
      await scen("shipment_sending", async (d, w, oo) => {
        await dispatch(w, oo.online);
        await setStatus(d, "status = 'sending', lease_token = gen_random_uuid(), lease_expires_at = now() + interval '90 seconds', attempts = 1");
      }, /sending:1/);
      await scen("shipment_uncertain", async (d, w, oo) => {
        await dispatch(w, oo.online);
        await setStatus(d, "status = 'uncertain', possibly_accepted = true, first_provider_request_at = now(), attempts = 1");
      }, /uncertain:1/);
      await scen("shipment_accepted", async (d, w, oo) => {
        await dispatch(w, oo.online);
        await setStatus(d, "status = 'accepted', accepted_at = now(), provider_message_id = 'msg_1', attempts = 1");
      }, /accepted:1/);
      await scen("shipment_no_recipient", async (_d, w, oo) => { await dispatch(w, oo.noEmail); }, /failed:1/);
      await scen("mixed_with_in_person", async (_d, w, oo) => { await dispatch(w, oo.inPerson); await dispatch(w, oo.online); }, /pending:1/);

      // A dispatch in progress (not yet committed) when the rollback starts.
      await engine.database("b_lock", "0075");
      const d = await open("b_lock");
      const oo = await seedOrders(d);
      const adm = await makeAdmin(d, "adm-b-lock@example.test");
      const holder = await open("b_lock");
      await asAdmin(holder, adm);
      await holder.query("begin");
      await holder.query("select dispatch_order($1, 'india_post_speed_post', 'EE123456785IN', true)", [oo.online]);
      const s = await state(d);
      const timed = await run("0075", d, "b_lock");
      t("0075 concurrent dispatch in progress: lock timeout refuses, nothing changed", await reject(timed, /lock timeout/i) && await unchanged(d, s));
      await holder.query("commit");
      await asRoot(holder);
      t("…once it commits, the shipping row it created refuses the rollback (R1)", await reject(await run("0075", d, "b_lock"), /\(R1\)/));
    }

    // ══ C. 0074 ═══════════════════════════════════════════════════════════
    console.log("\n=== C. 0074 rollback (confirmation deliveries) ===");
    {
      await engine.database("c", "0074");
      const c = await open("c");
      await seedOrders(c);
      await c.query("insert into schema_migrations (filename) values ($1) on conflict do nothing", [M74]);
      const before = await orders(c);
      for (const [db, re] of [["b0075", /\(P2\): 0075 is still applied/], ["b0073", /\(P1\)/]] as const) {
        const x = await open(db);
        const s = await state(x);
        t(`0074 rollback on ${db}: refused, unchanged`, await reject(await run("0074", x, db), re) && await unchanged(x, s));
      }
      // 0076 without 0075 (0076 has no dependency on 0075): still refused.
      await engine.database("c76", "0074");
      const c76 = await open("c76");
      await apply(c76, M76);
      const s76 = await state(c76);
      t("0074 rollback with 0076 present (0075 absent): refused (P2), unchanged",
        await reject(await run("0074", c76, "c76"), /\(P2\): 0076 is still applied/) && await unchanged(c76, s76));

      const r = await run("0074", c, "c");
      t("safe rollback succeeds (no delivery rows; old-code claims present)", r.code === 0 && /ROLLED BACK 0074/.test(r.out), r.out);
      t("the recovery cutoff is printed for the record", /orphan_recovery_since was 20\d\d-/.test(r.out));
      t("catalog == clean 0073", diff(S["0073"], await snapshot(c)) === "", diff(S["0073"], await snapshot(c)));
      t("security posture == clean 0073", comparePostures(P["0073"], await posture(c)).length === 0);
      if (manifest73) t("security posture == committed 0073 manifest", comparePostures(manifest73, await posture(c)).length === 0);
      t("every order kept exactly, incl. confirmation_sent_at claims", (await orders(c)) === before);
      t("0074 ledger row gone", (await ledger(c, M74)) === 0);

      // Refusals: deliveries in every state, made by the real functions where they can be.
      const scen = async (name: string, act: (d: Client, w: Client, o: Record<string, string>) => Promise<void>, re: RegExp) => {
        const db = `c_${name}`;
        await engine.database(db, "0074");
        const d = await open(db);
        const oo = await seedOrders(d);
        await d.query("insert into schema_migrations (filename) values ($1) on conflict do nothing", [M74]);
        const ww = await open(db);
        await asService(ww);
        await act(d, ww, oo);
        await asRoot(ww);
        const s = await state(d);
        const rr = await run("0074", d, db);
        t(`0074 ${name}: refused`, await reject(rr, re), rr.out);
        t(`0074 ${name}: nothing changed (catalog, orders, deliveries, ledger)`, await unchanged(d, s));
      };
      const enqueue = async (w: Client, id: string) => (await w.query("select * from enqueue_order_confirmation($1)", [id])).rows[0].delivery_id as string;
      const set = (d: Client, id: string, sql: string) => d.query(`update order_email_deliveries set ${sql} where id = $1`, [id]);
      await scen("pending", async (_d, w, oo) => { await enqueue(w, oo.online); }, /\(R1\): delivery records exist \(order_confirmation\/pending:1\)/);
      await scen("no_recipient_failed", async (_d, w, oo) => { await enqueue(w, oo.noEmail); }, /order_confirmation\/failed:1/);
      await scen("sending_leased", async (_d, w, oo) => {
        const id = await enqueue(w, oo.online);
        await w.query("select * from claim_order_email_delivery($1, 90)", [id]);
      }, /order_confirmation\/sending:1/);
      await scen("uncertain", async (d, w, oo) => {
        const id = await enqueue(w, oo.online);
        await set(d, id, "status = 'uncertain', possibly_accepted = true, first_provider_request_at = now(), attempts = 1");
      }, /uncertain:1/);
      await scen("retryable", async (d, w, oo) => {
        const id = await enqueue(w, oo.online);
        await set(d, id, "status = 'retryable', attempts = 1, last_error_code = 'rate_limited'");
      }, /retryable:1/);
      await scen("accepted", async (d, w, oo) => {
        const id = await enqueue(w, oo.online);
        await set(d, id, "status = 'accepted', accepted_at = now(), provider_message_id = 'msg_1', attempts = 1");
      }, /accepted:1/);
      await scen("expired", async (d, w, oo) => {
        const id = await enqueue(w, oo.online);
        await set(d, id, "status = 'expired', possibly_accepted = true, first_provider_request_at = now() - interval '2 days', attempts = 1");
      }, /expired:1/);
      await scen("settings_tampered", async (d) => { await d.query("delete from order_email_recovery_settings"); }, /\(R2\): order_email_recovery_settings holds 0 rows/);

      // A settlement in progress (enqueue not yet committed) when the rollback starts.
      await engine.database("c_lock", "0074");
      const d = await open("c_lock");
      const oo = await seedOrders(d);
      const holder = await open("c_lock");
      await asService(holder);
      await holder.query("begin");
      await holder.query("select * from enqueue_order_confirmation($1)", [oo.online]);
      const s = await state(d);
      t("0074 concurrent settlement in progress: lock timeout refuses, nothing changed",
        await reject(await run("0074", d, "c_lock"), /lock timeout/i) && await unchanged(d, s));
      await holder.query("commit");
      await asRoot(holder);
      t("…once it commits, its delivery row refuses the rollback (R1)", await reject(await run("0074", d, "c_lock"), /\(R1\)/));
    }

    // ══ D. The chain ══════════════════════════════════════════════════════
    console.log("\n=== D. 0074 → 0075 → 0076 up; 0076 → 0075 → 0074 down; up again ===");
    {
      await engine.database("chain", "0073");
      const c = await open("chain");
      await seedOrders(c);
      const before = await orders(c);
      for (const f of [M74, M75, M76]) await apply(c, f);
      t("forward 0074 → 0075 → 0076 == clean 0076 (catalog and posture)",
        diff(S["0076"], await snapshot(c)) === "" && comparePostures(P["0076"], await posture(c)).length === 0);
      const s = await state(c);
      t("out of order: 0074 first is refused (P2), unchanged", await reject(await run("0074", c, "chain"), /\(P2\)/) && await unchanged(c, s));
      t("out of order: 0075 before 0076 is refused (P2), unchanged", await reject(await run("0075", c, "chain"), /\(P2\)/) && await unchanged(c, s));
      for (const [m, snap] of [["0076", "0075"], ["0075", "0074"], ["0074", "0073"]] as const) {
        const r = await run(m, c, "chain");
        t(`down: ${m} rolled back → catalog == clean ${snap}`, r.code === 0 && diff(S[snap], await snapshot(c)) === "", r.out + diff(S[snap], await snapshot(c)));
      }
      const p73 = await posture(c);
      t("down: final security posture == clean 0073", comparePostures(P["0073"], p73).length === 0);
      if (manifest73) t(`down: final security posture == committed manifest at ${MANIFEST_0073_COMMIT}`, comparePostures(manifest73, p73).length === 0, comparePostures(manifest73, p73).join("; "));
      t("down: orders unchanged; ledger has none of 0074–0076", (await orders(c)) === before
        && (await ledger(c, M74)) + (await ledger(c, M75)) + (await ledger(c, M76)) === 0);
      for (const f of [M74, M75, M76]) await apply(c, f);
      t("up again: catalog == clean 0076", diff(S["0076"], await snapshot(c)) === "", diff(S["0076"], await snapshot(c)));
      t("up again: security posture == clean 0076 and == this checkout's manifest",
        comparePostures(P["0076"], await posture(c)).length === 0 && comparePostures(manifestHere, await posture(c)).length === 0);
      t("up again: orders unchanged; ledger rows back", (await orders(c)) === before
        && (await ledger(c, M74)) + (await ledger(c, M75)) + (await ledger(c, M76)) === 3);
    }
  } finally {
    for (const c of conns) await c.end().catch(() => {});
    await engine.stop();
  }
  console.log(`\nmigration-recovery: ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ""}`);
  process.exit(fail ? 1 : 0);
}

const watchdog = setTimeout(() => {
  console.log("  FAIL  did not finish within 900 s");
  process.exit(1);
}, 900_000);
main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => clearTimeout(watchdog));
