/**
 * Analytics daily aggregates (migration 0069) — look, prove, and re-run.
 *
 *   node scripts/analytics-rollup.mjs status              coverage, last jobs, the pg_cron schedule
 *   node scripts/analytics-rollup.mjs reconcile 2026-10-12  raw vs aggregate for one IST day
 *   node scripts/analytics-rollup.mjs rollup 2026-10-12     rebuild one finished IST day from raw events
 *   node scripts/analytics-rollup.mjs nightly             run the nightly job now (rebuild + purge)
 *
 * Dates are IST calendar dates, printed as text (node-pg would otherwise
 * turn a date into a local-midnight timestamp and shift it).
 *
 * status and reconcile are read-only (a READ ONLY transaction, rolled back).
 * rollup and nightly write, in one transaction, as the database owner — the
 * only role that may run them; the scheduled job (0070) runs the same
 * function. Reads SUPABASE_DB_URL from .env.local.
 */
import fs from "node:fs";
import pg from "pg";

const [action, day] = process.argv.slice(2);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
if (!["status", "reconcile", "rollup", "nightly"].includes(action) ||
    (["reconcile", "rollup"].includes(action) && !DAY.test(day ?? ""))) {
  console.error("usage: node scripts/analytics-rollup.mjs status | reconcile YYYY-MM-DD | rollup YYYY-MM-DD | nightly");
  process.exit(1);
}

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);
if (!env.SUPABASE_DB_URL) {
  console.error("SUPABASE_DB_URL is not set in .env.local");
  process.exit(1);
}

const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
const writes = action === "rollup" || action === "nightly";
const show = (x) => console.log(JSON.stringify(x, null, 2));

try {
  await client.connect();
  await client.query(writes ? "begin" : "begin read only");
  if (action === "status") {
    show((await client.query(`
      select (select collecting from public.analytics_config where id) collecting,
             public.analytics_day_of(now())::text today_ist,
             (select count(*) from public.analytics_events)::int raw_events,
             (select min(public.analytics_day_of(occurred_at))::text from public.analytics_events) oldest_raw_day,
             (select count(*) from public.analytics_daily)::int aggregate_rows,
             (select count(*) from public.analytics_daily_runs)::int days_rolled_up,
             (select max(day)::text from public.analytics_daily_runs) latest_rolled_up,
             (select count(*) from public.analytics_daily_runs where raw_purged_at is not null)::int days_purged`)).rows[0]);
    console.log("last 14 days:");
    console.table((await client.query(`
      select d::date::text as day, r.rolled_up_at, r.customer_events customer, r.internal_events internal, r.test_events test, r.aggregate_rows rows
        from generate_series(public.analytics_day_of(now()) - 14, public.analytics_day_of(now()) - 1, interval '1 day') d
        left join public.analytics_daily_runs r on r.day = d::date order by 1`)).rows);
    console.log("last jobs:");
    console.table((await client.query("select ran_at, job, ok, detail->>'stage' stage, detail->>'error' error from public.analytics_job_log order by ran_at desc limit 5")).rows);
    const cron = (await client.query("select to_regclass('cron.job') is not null c")).rows[0].c;
    if (cron) {
      console.log("schedule:");
      console.table((await client.query("select jobid, jobname, schedule, command, active from cron.job where jobname = 'wovenne-analytics-nightly'")).rows);
      console.table((await client.query(`select start_time, end_time, status, left(return_message, 120) message from cron.job_run_details
        where jobid = (select jobid from cron.job where jobname = 'wovenne-analytics-nightly') order by start_time desc limit 5`)).rows);
    } else {
      console.log("schedule: pg_cron is not installed (migration 0070 not applied)");
    }
  } else if (action === "reconcile") {
    // The owner is not an admin session; the read gate admits the service role.
    await client.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    show((await client.query("select public.analytics_reconcile($1::date) r", [day])).rows[0].r);
  } else if (action === "rollup") {
    show((await client.query("select public.analytics_rollup_day($1::date) r", [day])).rows[0].r);
  } else {
    show((await client.query("select public.analytics_nightly() r")).rows[0].r);
  }
  await client.query(writes ? "commit" : "rollback");
} catch (e) {
  await client.query("rollback").catch(() => {});
  console.error("failed:", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
