-- 0070 — Schedule the analytics nightly job (pg_cron)
--
-- One job, inside the database: at 20:30 UTC = 02:00 Asia/Kolkata, after the
-- Wovenne business day has ended, run analytics_nightly() (0069) — rebuild
-- recent days, then purge raw events older than 180 days that are covered by
-- a matching rollup.
--
-- Why pg_cron: the work is pure SQL on data that never leaves the database. A
-- Vercel Cron would need a public endpoint, a shared secret in the
-- environment and the service-role key to do the same thing from outside.
-- pg_cron needs none of that: the job runs as the database owner, which is
-- the only role allowed to call analytics_nightly(). Its own history is in
-- cron.job_run_details; the job's results are in analytics_job_log (0069).
--
-- Kept apart from 0069 on purpose: 0069 is plain SQL proven on a throwaway
-- Postgres; this is the one platform-specific step. Where pg_cron is not
-- offered (the test harness), this file does nothing and says so.
--
-- To stop the schedule: select cron.unschedule('wovenne-analytics-nightly');
--
-- Applied with scripts/run-migration.mjs, in one transaction.

set local search_path = public, pg_temp;

do $$
declare
  v_tz text;
  v_ok boolean;
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice '0070: pg_cron is not available on this server; the nightly job is not scheduled';
    return;
  end if;

  create extension if not exists pg_cron;

  -- pg_cron reads schedules in cron.timezone (GMT unless changed). The
  -- schedule below is written in UTC; refuse anything else rather than run at
  -- the wrong hour of the Indian day.
  v_tz := coalesce(current_setting('cron.timezone', true), 'GMT');
  if v_tz not in ('GMT', 'UTC', 'Etc/UTC', 'Etc/GMT') then
    raise exception 'MIGRATION_0070_SELF_CHECK_FAILED: cron.timezone is %, expected UTC/GMT', v_tz;
  end if;

  -- Same name → the existing job is updated, never duplicated.
  perform cron.schedule('wovenne-analytics-nightly', '30 20 * * *', 'select public.analytics_nightly()');

  execute $q$
    select count(*) = 1 and bool_and(schedule = '30 20 * * *' and command = 'select public.analytics_nightly()' and active)
      from cron.job where jobname = 'wovenne-analytics-nightly'
  $q$ into v_ok;
  if not coalesce(v_ok, false) then
    raise exception 'MIGRATION_0070_SELF_CHECK_FAILED: the nightly job is not scheduled exactly once as intended';
  end if;
end $$;
