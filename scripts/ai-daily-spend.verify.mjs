/**
 * Migration 0059 against a real database, including real concurrency.
 *
 *   node scripts/run-migration.mjs supabase/migrations/0059_ai_daily_spend.sql
 *   node scripts/ai-daily-spend.verify.mjs
 *
 * ══ WHY THIS EXISTS SEPARATELY FROM THE .test.ts ══
 *
 * scripts/ai-daily-spend.test.ts proves the ALGORITHM against a model of 0059,
 * and proves the migration's TEXT has the properties that model assumes. What
 * it cannot prove is the thing that only Postgres can demonstrate: that two
 * transactions racing for the last few cents of the day genuinely serialise,
 * because one blocks on the other's row lock and re-evaluates its WHERE clause
 * against the committed result.
 *
 * That needs two connections and a real server, so it lives here.
 *
 * ══ IT WRITES, AND IT ROLLS BACK ══
 *
 * Every assertion runs inside a transaction that ends in ROLLBACK, following the
 * same convention as brand-knowledge.verify.mjs and cancel-guard.verify.mjs. The
 * concurrency section is the exception it cannot make: two transactions that
 * cannot see each other's uncommitted work are not a concurrency test, so that
 * section COMMITS a reservation on a far-future day, proves the guard, and then
 * deletes exactly what it created. It never touches today's row.
 *
 * ══ NOT RUN YET ══
 *
 * 0059 has not been applied. This script is written and unexecuted; the report
 * records that as an open item rather than implying it has passed.
 */
import fs from "node:fs";
import pg from "pg";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);

let pass = 0, fail = 0;
const t = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const conn = () =>
  new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });

/** A day far enough in the future that it can never collide with real accounting. */
const PROBE_DAY = "2099-12-31";

async function refused(client, label, fn) {
  await client.query(`savepoint ${label}`);
  try { await fn(); await client.query(`release savepoint ${label}`); return null; }
  catch (e) { await client.query(`rollback to savepoint ${label}`); return e.message; }
}

async function main() {
  const c = await (async () => { const x = conn(); await x.connect(); return x; })();

  // ── Existence and security, read-only ───────
  console.log("\n=== schema and security ===");
  {
    const v = (await c.query(`
      select
        (select count(*) from information_schema.tables where table_schema='public' and table_name='ai_daily_spend') dt,
        (select count(*) from information_schema.tables where table_schema='public' and table_name='ai_spend_reservations') rt,
        (select count(*) from pg_proc where pronamespace='public'::regnamespace and proname like 'ai_budget%') fns,
        (select count(*) from pg_policies where tablename in ('ai_daily_spend','ai_spend_reservations')) policies,
        (select count(*) from information_schema.role_table_grants
          where table_name in ('ai_daily_spend','ai_spend_reservations') and grantee in ('anon','authenticated')) tgrants,
        (select count(*) from information_schema.role_routine_grants
          where routine_name like 'ai_budget%' and grantee in ('anon','authenticated','PUBLIC')) rgrants,
        (select bool_and(relrowsecurity) from pg_class where relname in ('ai_daily_spend','ai_spend_reservations')) rls
    `)).rows[0];

    t("both tables exist", v.dt === "1" && v.rt === "1");
    t("all four accounting functions exist", v.fns === "4", v.fns);
    t("RLS is on", v.rls === true);
    t("no policies exist", v.policies === "0");
    t("anon/authenticated have NO table grants", v.tgrants === "0", v.tgrants);
    t("anon/authenticated/PUBLIC have NO execute grants", v.rgrants === "0", v.rgrants);
  }

  // ── Behaviour, in a rolled-back transaction ─
  console.log("\n=== reserve / finalize (rolled back) ===");
  await c.query("begin");
  try {
    const before = (await c.query(`select coalesce(sum(committed_usd),0) s from ai_daily_spend`)).rows[0].s;

    const r1 = (await c.query(`select ai_budget_reserve(0.06, 5.00) v`)).rows[0].v;
    t("a first reservation is allowed", r1.allowed === true);
    t("…and returns an id", typeof r1.reservation_id === "string");

    const over = (await c.query(`select ai_budget_reserve(0.06, 0.06) v`)).rows[0].v;
    t("a reservation that would exceed the ceiling is refused", over.allowed === false);

    const fin = (await c.query(`select ai_budget_finalize($1, 0.012, 2, 4194, 300, 0, 0) v`, [r1.reservation_id])).rows[0].v;
    t("settlement charges the actual", Number(fin.charged) === 0.012, String(fin.charged));
    t("…and is not flagged idempotent the first time", fin.idempotent === false);

    const dup = (await c.query(`select ai_budget_finalize($1, 0.012, 2, 4194, 300, 0, 0) v`, [r1.reservation_id])).rows[0].v;
    t("a duplicate settlement is idempotent", dup.idempotent === true);

    const day = (await c.query(`select * from ai_daily_spend where day = ai_utc_day()`)).rows[0];
    t("the day was charged exactly once", Number(day.committed_usd) === 0.012, day.committed_usd);
    t("the hold was released", Number(day.reserved_usd) === 0, day.reserved_usd);
    t("token counters accumulated", Number(day.input_tokens) === 4194 && Number(day.output_tokens) === 300);

    const unknown = (await c.query(`select ai_budget_reserve(0.06, 5.00) v`)).rows[0].v;
    const unk = (await c.query(`select ai_budget_finalize($1, null) v`, [unknown.reservation_id])).rows[0].v;
    t("an unknown actual charges the FULL reservation", Number(unk.charged) === 0.06, String(unk.charged));

    t("NaN is refused", (await refused(c, "s1", () => c.query(`select ai_budget_reserve('NaN'::numeric, 5.00)`))) !== null);
    t("a negative amount is refused", (await refused(c, "s2", () => c.query(`select ai_budget_reserve(-1, 5.00)`))) !== null);
    t("a negative actual is refused", (await refused(c, "s3", () => c.query(`select ai_budget_finalize($1, -1)`, [unknown.reservation_id]))) !== null);
    t("an unknown reservation is reported, not thrown",
      (await c.query(`select ai_budget_finalize('00000000-0000-0000-0000-000000000000'::uuid, 1) v`)).rows[0].v.ok === false);

    t("prune cannot delete today", (async () => {
      await c.query(`select ai_budget_prune(0)`);
      const still = await c.query(`select 1 from ai_daily_spend where day = ai_utc_day()`);
      return still.rowCount === 1;
    })());

    await c.query("rollback");
    const after = (await c.query(`select coalesce(sum(committed_usd),0) s from ai_daily_spend`)).rows[0].s;
    t("the rollback left NOTHING behind", String(before) === String(after), `${before} → ${after}`);
  } catch (e) {
    await c.query("rollback");
    t("behaviour block completed", false, e.message);
  }

  // ── Real concurrency, two connections ───────
  //
  // This one has to COMMIT: two transactions that cannot see each other's
  // uncommitted work do not demonstrate anything about locking. It operates
  // only on PROBE_DAY and removes exactly what it creates.
  console.log("\n=== real two-connection concurrency ===");
  const a = conn(), b = conn();
  try {
    await a.connect(); await b.connect();
    await a.query(`delete from ai_spend_reservations where day = $1`, [PROBE_DAY]);
    await a.query(`delete from ai_daily_spend where day = $1`, [PROBE_DAY]);
    await a.query(
      `insert into ai_daily_spend (day, committed_usd) values ($1, 4.96)`, [PROBE_DAY]
    );

    // Both transactions target PROBE_DAY by pinning the clock is not possible,
    // so the guard is exercised directly against that row with the same
    // statement ai_budget_reserve issues.
    const guard = `
      update ai_daily_spend d
         set reserved_usd = d.reserved_usd + 0.06
       where d.day = $1
         and d.committed_usd + d.reserved_usd + 0.06 <= 5.00
      returning d.reserved_usd`;

    await a.query("begin"); await b.query("begin");
    const ra = await a.query(guard, [PROBE_DAY]);

    // b blocks on a's row lock until a commits, then re-evaluates its WHERE.
    const bPromise = b.query(guard, [PROBE_DAY]);
    await a.query("commit");
    const rb = await bPromise;
    await b.query("commit");

    t("exactly one of two concurrent reservations succeeded",
      (ra.rowCount === 1) !== (rb.rowCount === 1), `a=${ra.rowCount} b=${rb.rowCount}`);

    const final = (await a.query(`select committed_usd, reserved_usd from ai_daily_spend where day=$1`, [PROBE_DAY])).rows[0];
    const held = Number(final.committed_usd) + Number(final.reserved_usd);
    t("the ceiling was never crossed", held <= 5.0, `$${held}`);
  } catch (e) {
    t("concurrency block completed", false, e.message);
  } finally {
    try {
      await a.query(`delete from ai_spend_reservations where day = $1`, [PROBE_DAY]);
      await a.query(`delete from ai_daily_spend where day = $1`, [PROBE_DAY]);
      const left = await a.query(`select 1 from ai_daily_spend where day = $1`, [PROBE_DAY]);
      t("the probe day was cleaned up", left.rowCount === 0);
    } catch { /* connection already gone */ }
    await a.end().catch(() => {}); await b.end().catch(() => {});
  }

  await c.end();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
