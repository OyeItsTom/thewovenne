-- 0069 — Analytics daily aggregates, reconciliation and safe retention (1B)
--
-- Raw events (0068) → verified daily totals that last after the raw rows are
-- gone. Design notes: docs/analytics.md §9.
--
-- WHAT A DAY IS. A Wovenne business day is a calendar day in Asia/Kolkata:
-- [d 00:00 IST, d+1 00:00 IST), i.e. [d-1 18:30 UTC, d 18:30 UTC). Raw
-- occurred_at stays UTC. Nothing here groups by a UTC date.
--
-- CUSTOMER TRAFFIC ONLY. Aggregate rows count traffic = 'customer' and nothing
-- else. Internal (staff) and test traffic are never in a business total; their
-- counts per day are kept beside the aggregates in analytics_daily_runs, and
-- analytics_reconcile() shows all three classes, so verification traffic is
-- visible without being counted.
--
-- COUNTS OF EVENTS, NOT PEOPLE. 0068 has no visitor or session identity, so no
-- aggregate here is, or can be turned into, unique visitors, sessions,
-- returning visitors or per-person conversion. A funnel built from these rows
-- is an EVENT funnel.
--
-- ONE TABLE, SIX GRAINS. analytics_daily holds one row per (day, grain,
-- event_type, dimension values) with the event count. A grain is one way of
-- slicing the same customer events:
--   total     no dimension — the day's count per event type
--   product   product_id (+ the category and name it had)
--   location  approximate country + first-level region (browser events)
--   device    mobile / tablet / desktop / NULL = unknown (browser events)
--   source    source, medium, campaign, referrer host (browser events)
--   search    submitted term + whether it found nothing
-- Grains are never crossed with each other (no product × region × source
-- cube): each grain's rows sum back to that event type's total, which is what
-- analytics_reconcile() checks. A crossing that is needed later is a new
-- grain, added deliberately.
--
-- PURCHASES come only from analytics_record_purchase() (0068): one event per
-- online order that became paid, classified customer / internal / test. Their
-- products and units are read from the order's own line snapshot
-- (orders.items), so a purchase reports what was actually sold. Purchases
-- carry no browser attribution, device or IP location, so they appear in the
-- total and product grains only. No money is aggregated here: order value is
-- the order system's (0025), and while Razorpay runs on test keys every
-- purchase is 'test' and no customer purchase exists.
--
-- REBUILT, NEVER INCREMENTED. analytics_rollup_day(d) deletes day d's rows and
-- recomputes them from raw events in one transaction, so a rerun cannot
-- double-count and a late event is picked up by the next rebuild. The nightly
-- job (analytics_nightly) rebuilds the last 3 finished days, any day in the
-- last 35 that was never rolled up, and any whose raw counts changed.
--
-- RETENTION. analytics_purge() now deletes raw events by whole IST day, only
-- for days that have a rollup whose counts still match the raw rows, at most
-- 7 days a call. A day it will not purge is reported, not deleted. Once a
-- day's raw rows are purged its aggregates are final: rollup refuses that day.
--
-- WHO MAY TOUCH IT.
--   anon / authenticated / service_role: no table privileges at all.
--   Admin reads: analytics_report() and analytics_reconcile(), behind
--   can_read_analytics() → is_admin() (0067: staff + aal2 + live session).
--   Rollup, nightly job, purge: the database owner only (pg_cron runs as the
--   owner — see 0070; manual runs: scripts/analytics-rollup.mjs).
--
-- Applied with scripts/run-migration.mjs, in one transaction.

set local search_path = public, pg_temp;

-- ── Daily aggregates ──────────────────────────
create table if not exists public.analytics_daily (
  day           date not null,
  grain         text not null check (grain in ('total', 'product', 'location', 'device', 'source', 'search')),
  event_type    text not null check (event_type in (
                  'page_view', 'product_view', 'search',
                  'wishlist_add', 'wishlist_remove', 'cart_add', 'cart_remove',
                  'checkout_start', 'whatsapp_click', 'purchase')),
  -- Product grain. No foreign keys: the history outlives the product. NULL
  -- product_id = the product row no longer existed when the day was rolled up.
  product_id    uuid,
  category_id   uuid,
  -- The product's name when the day was rolled up, so a deleted product still
  -- has a label. Reports prefer the current name while the product exists.
  product_name  text check (char_length(product_name) <= 200),
  -- Location grain: approximate, from the host's IP lookup (0068). No city.
  country_code  text check (country_code ~ '^[A-Z]{2}$'),
  region        text check (region ~ '^[A-Z0-9]{1,3}$'),
  device        text check (device in ('mobile', 'tablet', 'desktop')),
  -- Source grain, exactly as observed by the collector. NULL source = unknown.
  source        text check (source ~ '^[a-z0-9_.+-]{1,40}$'),
  medium        text check (medium ~ '^[a-z0-9_.+-]{1,40}$'),
  campaign      text check (char_length(campaign) <= 60),
  referrer_host text check (char_length(referrer_host) <= 100),
  -- Search grain: the stored (normalised, redaction-applied) term.
  search_term   text check (char_length(search_term) between 1 and 64),
  -- true = the search found nothing; NULL = result count not captured.
  zero_results  boolean,
  events        integer not null check (events > 0),
  -- cart_add / cart_remove: units moved; purchase: units sold. Otherwise NULL.
  units         integer check (units >= 0),
  -- page_view only: how many were the first page of a page load (landings).
  entries       integer not null default 0 check (entries >= 0 and entries <= events),
  constraint analytics_daily_grain_shape check (case grain
    when 'total' then num_nonnulls(product_id, category_id, product_name, country_code, region, device,
                                   source, medium, campaign, referrer_host, search_term, zero_results) = 0
    when 'product' then num_nonnulls(country_code, region, device, source, medium, campaign,
                                     referrer_host, search_term, zero_results) = 0
                    and event_type in ('product_view', 'wishlist_add', 'wishlist_remove', 'cart_add', 'cart_remove', 'purchase')
    when 'location' then num_nonnulls(product_id, category_id, product_name, device, source, medium, campaign,
                                      referrer_host, search_term, zero_results) = 0
                     and event_type <> 'purchase'
    when 'device' then num_nonnulls(product_id, category_id, product_name, country_code, region, source, medium,
                                    campaign, referrer_host, search_term, zero_results) = 0
                   and event_type <> 'purchase'
    when 'source' then num_nonnulls(product_id, category_id, product_name, country_code, region, device,
                                    search_term, zero_results) = 0
                   and event_type <> 'purchase'
    when 'search' then num_nonnulls(product_id, category_id, product_name, country_code, region, device,
                                    source, medium, campaign, referrer_host) = 0
                   and event_type = 'search' and search_term is not null
  end)
);

-- One row per day, grain, event type and dimension values. NULL is a value
-- here ("unknown"), so two unknowns are the same row.
create unique index if not exists analytics_daily_key on public.analytics_daily
  (day, grain, event_type, product_id, country_code, region, device, source, medium, campaign,
   referrer_host, search_term, zero_results) nulls not distinct;
-- What every report asks: one grain over a date range.
create index if not exists analytics_daily_grain_day_idx on public.analytics_daily (grain, day);

-- ── Coverage: which days are rolled up, and what the raw rows said ──
create table if not exists public.analytics_daily_runs (
  day                date primary key,
  rolled_up_at       timestamptz not null,
  -- Raw rows in the IST day at rollup, by traffic class (all event types).
  customer_events    integer not null check (customer_events >= 0),
  internal_events    integer not null check (internal_events >= 0),
  test_events        integer not null check (test_events >= 0),
  aggregate_rows     integer not null check (aggregate_rows >= 0),
  -- Set once the day's raw rows are purged; from then on the aggregate is final.
  raw_purged_at      timestamptz,
  raw_purged_events  integer check (raw_purged_events >= 0)
);

-- ── What the scheduled job did, each time ─────
create table if not exists public.analytics_job_log (
  id       bigint generated always as identity primary key,
  ran_at   timestamptz not null default now(),
  job      text not null check (job in ('nightly', 'rollup', 'purge')),
  ok       boolean not null,
  detail   jsonb not null default '{}'::jsonb
);
create index if not exists analytics_job_log_ran_idx on public.analytics_job_log (ran_at);

alter table public.analytics_daily      enable row level security;
alter table public.analytics_daily_runs enable row level security;
alter table public.analytics_job_log    enable row level security;
revoke all on public.analytics_daily, public.analytics_daily_runs, public.analytics_job_log
  from public, anon, authenticated, service_role;
revoke all on sequence public.analytics_job_log_id_seq from public, anon, authenticated, service_role;

-- ── IST day bounds ────────────────────────────
-- The UTC instant a Wovenne business day starts. Asia/Kolkata has no daylight
-- saving, so every day is exactly 24 hours: [start(d), start(d + 1)).
create or replace function public.analytics_day_start(p_day date)
returns timestamptz
language sql
stable
set search_path = public, pg_temp
as $fn$
  select (p_day::timestamp at time zone 'Asia/Kolkata');
$fn$;

-- The business day an instant belongs to.
create or replace function public.analytics_day_of(p_at timestamptz)
returns date
language sql
stable
set search_path = public, pg_temp
as $fn$
  select (p_at at time zone 'Asia/Kolkata')::date;
$fn$;

revoke execute on function public.analytics_day_start(date) from public, anon, authenticated, service_role;
revoke execute on function public.analytics_day_of(timestamptz) from public, anon, authenticated, service_role;

-- ── Rollup: rebuild one day from raw events ───
create or replace function public.analytics_rollup_day(p_day date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_from   timestamptz;
  v_to     timestamptz;
  v_run    public.analytics_daily_runs%rowtype;
  v_labels jsonb;
  v_rows   integer;
  v_cust   integer;
  v_int    integer;
  v_test   integer;
begin
  if p_day is null then
    raise exception 'analytics_rollup_day: a day is required';
  end if;
  if p_day >= public.analytics_day_of(now()) then
    raise exception 'analytics_rollup_day: % has not finished in Asia/Kolkata', p_day;
  end if;
  -- One rebuild of a day at a time.
  perform pg_advisory_xact_lock(hashtext('analytics_rollup_day'), (p_day - date '2000-01-01'));

  select * into v_run from public.analytics_daily_runs where day = p_day;
  if found and v_run.raw_purged_at is not null then
    raise exception 'analytics_rollup_day: raw events for % were purged; its aggregates are final', p_day;
  end if;

  v_from := public.analytics_day_start(p_day);
  v_to   := public.analytics_day_start(p_day + 1);

  -- Keep the names products had, for any product deleted since.
  select coalesce(jsonb_object_agg(product_id::text, product_name), '{}'::jsonb) into v_labels
    from public.analytics_daily
   where day = p_day and grain = 'product' and product_id is not null and product_name is not null;

  delete from public.analytics_daily where day = p_day;

  insert into public.analytics_daily
    (day, grain, event_type, product_id, category_id, product_name, country_code, region, device,
     source, medium, campaign, referrer_host, search_term, zero_results, events, units, entries)
  with ev as (
    select * from public.analytics_events
     where occurred_at >= v_from and occurred_at < v_to and traffic = 'customer'
  ),
  browser as (select * from ev where event_type <> 'purchase'),
  purchases as (select id, order_id from ev where event_type = 'purchase'),
  -- What each purchase sold, from the order's line snapshot.
  lines as (
    select p.id as event_id,
           case when item->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then (item->>'id')::uuid end as product_id,
           case when item->>'quantity' ~ '^[0-9]{1,6}$' then (item->>'quantity')::integer else 0 end as qty,
           left(item->>'name', 200) as item_name
      from purchases p
      join public.orders o on o.id = p.order_id
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end) item
  ),
  unit_types as (select unnest(array['cart_add', 'cart_remove']) t)
  -- total
  select p_day, 'total', event_type, null::uuid, null::uuid, null, null, null, null, null, null, null, null, null, null::boolean,
         count(*)::integer,
         case when event_type in (select t from unit_types) then coalesce(sum(quantity), 0)::integer end,
         (count(*) filter (where is_entry and event_type = 'page_view'))::integer
    from browser group by event_type
  union all
  select p_day, 'total', 'purchase', null, null, null, null, null, null, null, null, null, null, null, null,
         (select count(*) from purchases)::integer,
         (select coalesce(sum(qty), 0) from lines)::integer, 0
   where exists (select 1 from purchases)
  -- product: browser product events
  union all
  select p_day, 'product', b.event_type, b.product_id,
         (array_agg(b.category_id order by b.occurred_at desc, b.id desc))[1],
         left(coalesce(pr.name, v_labels->>b.product_id::text), 200),
         null, null, null, null, null, null, null, null, null,
         count(*)::integer,
         case when b.event_type in (select t from unit_types) then coalesce(sum(b.quantity), 0)::integer end,
         0
    from browser b
    left join public.products pr on pr.id = b.product_id
   where b.event_type in ('product_view', 'wishlist_add', 'wishlist_remove', 'cart_add', 'cart_remove')
   group by b.event_type, b.product_id, pr.name
  -- product: purchases (events = orders containing it, units = units sold)
  union all
  select p_day, 'product', 'purchase', l.product_id, pr.category_id,
         left(coalesce(pr.name, v_labels->>l.product_id::text, max(l.item_name)), 200),
         null, null, null, null, null, null, null, null, null,
         count(distinct l.event_id)::integer, sum(l.qty)::integer, 0
    from lines l
    left join public.products pr on pr.id = l.product_id
   group by l.product_id, pr.category_id, pr.name
  -- location
  union all
  select p_day, 'location', event_type, null, null, null, country_code, region, null, null, null, null, null, null, null,
         count(*)::integer,
         case when event_type in (select t from unit_types) then coalesce(sum(quantity), 0)::integer end,
         (count(*) filter (where is_entry and event_type = 'page_view'))::integer
    from browser group by event_type, country_code, region
  -- device
  union all
  select p_day, 'device', event_type, null, null, null, null, null, device, null, null, null, null, null, null,
         count(*)::integer,
         case when event_type in (select t from unit_types) then coalesce(sum(quantity), 0)::integer end,
         (count(*) filter (where is_entry and event_type = 'page_view'))::integer
    from browser group by event_type, device
  -- source
  union all
  select p_day, 'source', event_type, null, null, null, null, null, null,
         source, medium, utm_campaign, referrer_host, null, null,
         count(*)::integer,
         case when event_type in (select t from unit_types) then coalesce(sum(quantity), 0)::integer end,
         (count(*) filter (where is_entry and event_type = 'page_view'))::integer
    from browser group by event_type, source, medium, utm_campaign, referrer_host
  -- search
  union all
  select p_day, 'search', 'search', null, null, null, null, null, null, null, null, null, null,
         search_term, case when result_count is null then null else result_count = 0 end,
         count(*)::integer, null, 0
    from browser where event_type = 'search'
   group by search_term, case when result_count is null then null else result_count = 0 end;

  get diagnostics v_rows = row_count;

  select count(*) filter (where traffic = 'customer'), count(*) filter (where traffic = 'internal'),
         count(*) filter (where traffic = 'test')
    into v_cust, v_int, v_test
    from public.analytics_events where occurred_at >= v_from and occurred_at < v_to;

  insert into public.analytics_daily_runs (day, rolled_up_at, customer_events, internal_events, test_events, aggregate_rows)
  values (p_day, now(), v_cust, v_int, v_test, v_rows)
  on conflict (day) do update
    set rolled_up_at = excluded.rolled_up_at, customer_events = excluded.customer_events,
        internal_events = excluded.internal_events, test_events = excluded.test_events,
        aggregate_rows = excluded.aggregate_rows;

  return jsonb_build_object('day', p_day, 'customer_events', v_cust, 'internal_events', v_int,
                            'test_events', v_test, 'aggregate_rows', v_rows);
end;
$fn$;

revoke execute on function public.analytics_rollup_day(date) from public, anon, authenticated, service_role;

-- ── Retention: purge raw events by covered IST day ──
-- Replaces 0068's age-only purge. A day's raw rows are deleted only when:
--   * the whole day is older than p_days (default 180, minimum 30);
--   * the day has a rollup; and
--   * the raw rows still match it — the customer, internal and test counts
--     recorded at rollup, and the total grain summing to the customer count.
-- Anything else is skipped and reported, never deleted. At most 7 days are
-- purged per call; the nightly job works through any backlog a week a night.
create or replace function public.analytics_purge(p_days integer default 180)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_cutoff  date;
  v_day     date;
  v_run     public.analytics_daily_runs%rowtype;
  v_cust    integer;
  v_int     integer;
  v_test    integer;
  v_agg     integer;
  v_n       integer;
  v_events  integer := 0;
  v_days    jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_more    boolean;
begin
  if p_days is null or p_days < 30 then
    raise exception 'analytics_purge: keep at least 30 days';
  end if;
  perform pg_advisory_xact_lock(hashtext('analytics_purge'));
  -- Days strictly before this one are eligible.
  v_cutoff := public.analytics_day_of(now()) - p_days;

  -- Oldest first. A skipped day does not use up one of the 7, so days that
  -- cannot be purged never block the ones behind them.
  for v_day in
    select public.analytics_day_of(occurred_at) d
      from public.analytics_events
     where occurred_at < public.analytics_day_start(v_cutoff)
     group by 1 order by 1
  loop
    exit when jsonb_array_length(v_days) >= 7;
    select * into v_run from public.analytics_daily_runs where day = v_day;
    if not found then
      v_skipped := v_skipped || jsonb_build_object('day', v_day, 'reason', 'not rolled up');
      continue;
    end if;
    select count(*) filter (where traffic = 'customer'), count(*) filter (where traffic = 'internal'),
           count(*) filter (where traffic = 'test')
      into v_cust, v_int, v_test
      from public.analytics_events
     where occurred_at >= public.analytics_day_start(v_day) and occurred_at < public.analytics_day_start(v_day + 1);
    select coalesce(sum(events), 0) into v_agg from public.analytics_daily where day = v_day and grain = 'total';
    if v_cust <> v_run.customer_events or v_int <> v_run.internal_events or v_test <> v_run.test_events
       or v_agg <> v_cust then
      v_skipped := v_skipped || jsonb_build_object('day', v_day, 'reason', 'raw rows differ from the rollup');
      continue;
    end if;
    delete from public.analytics_events
     where occurred_at >= public.analytics_day_start(v_day) and occurred_at < public.analytics_day_start(v_day + 1);
    get diagnostics v_n = row_count;
    update public.analytics_daily_runs set raw_purged_at = now(), raw_purged_events = v_n where day = v_day;
    v_events := v_events + v_n;
    v_days := v_days || to_jsonb(v_day);
  end loop;

  v_more := exists (
    select 1 from public.analytics_events e
     where e.occurred_at < public.analytics_day_start(v_cutoff)
       and not exists (select 1 from jsonb_array_elements(v_skipped) s
                        where (s->>'day')::date = public.analytics_day_of(e.occurred_at)));

  delete from public.analytics_rate where window_start < now() - interval '10 minutes';

  return jsonb_build_object('keep_days', p_days, 'purged_before', v_cutoff, 'days', v_days,
                            'events', v_events, 'skipped', v_skipped, 'more_remaining', v_more);
end;
$fn$;

revoke execute on function public.analytics_purge(integer) from public, anon, authenticated, service_role;

-- ── The nightly job ───────────────────────────
-- Run once a day after the IST day has ended (0070 schedules 02:00 IST).
--   1. Rebuild: the last 3 finished days always (absorbs anything that landed
--      around midnight), every day in the last 35 with no rollup (absorbs
--      missed nights), and every day in the last 35 whose raw counts no longer
--      match its rollup. Days before the first raw event are not invented.
--   2. Purge (180 days) — only if every rebuild succeeded.
--   3. Trim this job's own log to 400 days.
-- Every outcome, including a failure, is written to analytics_job_log; a
-- failure re-raises nothing, so the log row survives for diagnostics.
create or replace function public.analytics_nightly()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_yesterday date := public.analytics_day_of(now()) - 1;
  v_first     date;
  v_day       date;
  v_rebuilt   jsonb := '[]'::jsonb;
  v_purge     jsonb;
  v_result    jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('analytics_nightly'));

  begin
    select public.analytics_day_of(min(occurred_at)) into v_first from public.analytics_events;
    if v_first is not null then
      for v_day in
        with days as (
          select d::date as day
            from generate_series(greatest(v_first, v_yesterday - 34), v_yesterday, interval '1 day') d
        ),
        raw as (
          select public.analytics_day_of(occurred_at) as day,
                 count(*) filter (where traffic = 'customer') c, count(*) filter (where traffic = 'internal') i,
                 count(*) filter (where traffic = 'test') t
            from public.analytics_events
           where occurred_at >= public.analytics_day_start(greatest(v_first, v_yesterday - 34))
             and occurred_at < public.analytics_day_start(v_yesterday + 1)
           group by 1
        )
        select d.day
          from days d
          left join raw r on r.day = d.day
          left join public.analytics_daily_runs u on u.day = d.day
         where u.raw_purged_at is null
           and (u.day is null
                or d.day >= v_yesterday - 2
                or coalesce(r.c, 0) <> u.customer_events
                or coalesce(r.i, 0) <> u.internal_events
                or coalesce(r.t, 0) <> u.test_events)
         order by d.day
      loop
        perform public.analytics_rollup_day(v_day);
        v_rebuilt := v_rebuilt || to_jsonb(v_day);
      end loop;
    end if;
  exception when others then
    v_result := jsonb_build_object('stage', 'rollup', 'error', sqlerrm, 'rolled_back', v_rebuilt);
    insert into public.analytics_job_log (job, ok, detail) values ('nightly', false, v_result);
    return v_result || jsonb_build_object('ok', false);
  end;

  begin
    v_purge := public.analytics_purge(180);
  exception when others then
    v_result := jsonb_build_object('stage', 'purge', 'error', sqlerrm, 'rebuilt', v_rebuilt);
    insert into public.analytics_job_log (job, ok, detail) values ('nightly', false, v_result);
    return v_result || jsonb_build_object('ok', false);
  end;

  delete from public.analytics_job_log where ran_at < now() - interval '400 days';

  v_result := jsonb_build_object('rebuilt', v_rebuilt, 'purge', v_purge);
  insert into public.analytics_job_log (job, ok, detail) values ('nightly', true, v_result);
  return v_result || jsonb_build_object('ok', true);
end;
$fn$;

revoke execute on function public.analytics_nightly() from public, anon, authenticated, service_role;

-- ── Reports for the admin (the 1C data contract) ──
-- Customer aggregates for [p_from, p_to] (IST days, inclusive) in one grain.
--   total: one row per day and event type (a daily series);
--   other grains: summed over the range, one row per event type + dimensions.
-- Plus coverage: which days in the range have no rollup (those are unknown,
-- not zero) and whether today's partial day is excluded (always).
create or replace function public.analytics_report(p_from date, p_to date, p_grain text)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $fn$
declare
  v_rows     jsonb;
  v_covered  integer;
  v_missing  jsonb;
begin
  if not public.can_read_analytics() then
    raise exception 'Only admins can view analytics';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 1830 then
    raise exception 'analytics_report: invalid range';
  end if;
  if p_grain is null or p_grain not in ('total', 'product', 'location', 'device', 'source', 'search') then
    raise exception 'analytics_report: unknown grain';
  end if;

  select count(*), coalesce(jsonb_agg(d.day order by d.day) filter (where u.day is null), '[]'::jsonb)
    into v_covered, v_missing
    from (select g::date as day from generate_series(p_from, p_to, interval '1 day') g) d
    left join public.analytics_daily_runs u on u.day = d.day;
  v_covered := v_covered - jsonb_array_length(v_missing);

  if p_grain = 'total' then
    select coalesce(jsonb_agg(jsonb_build_object('day', day, 'event_type', event_type,
             'events', events, 'units', units, 'entries', entries) order by day, event_type), '[]'::jsonb)
      into v_rows
      from public.analytics_daily
     where grain = 'total' and day between p_from and p_to;
  else
    -- Sum first (plain columns), name products after, build JSON last.
    with g as (
      select event_type, product_id, max(product_name) as product_name, country_code, region, device,
             source, medium, campaign, referrer_host, search_term, zero_results,
             sum(events)::bigint as events, sum(units)::bigint as units, sum(entries)::bigint as entries
        from public.analytics_daily
       where grain = p_grain and day between p_from and p_to
       group by event_type, product_id, country_code, region, device,
                source, medium, campaign, referrer_host, search_term, zero_results
    )
    select coalesce(jsonb_agg(
             jsonb_strip_nulls(jsonb_build_object(
               'event_type', g.event_type,
               'product_id', g.product_id,
               'product_name', coalesce(pr.name, g.product_name),
               'product_exists', case when p_grain = 'product' then pr.id is not null end,
               'country_code', g.country_code, 'region', g.region,
               'device', g.device,
               'source', g.source, 'medium', g.medium, 'campaign', g.campaign, 'referrer_host', g.referrer_host,
               'search_term', g.search_term, 'zero_results', g.zero_results)) ||
             jsonb_build_object('events', g.events, 'units', g.units, 'entries', g.entries,
                                'unknown', (p_grain = 'location' and g.country_code is null)
                                        or (p_grain = 'device' and g.device is null)
                                        or (p_grain = 'source' and g.source is null))
             order by g.events desc, g.event_type, g.product_id, g.country_code, g.region, g.device,
                      g.source, g.medium, g.campaign, g.referrer_host, g.search_term, g.zero_results), '[]'::jsonb)
      into v_rows
      from g
      left join public.products pr on p_grain = 'product' and pr.id = g.product_id;
  end if;

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'grain', p_grain, 'traffic', 'customer',
    'days', p_to - p_from + 1, 'covered_days', v_covered, 'missing_days', v_missing,
    'rows', v_rows);
end;
$fn$;

revoke execute on function public.analytics_report(date, date, text) from public, anon;
grant execute on function public.analytics_report(date, date, text) to authenticated, service_role;

-- ── Reconciliation: why does a number say what it says? ──
-- For one IST day: the exact UTC window; raw counts per event type for
-- customer / internal / test (while raw rows are retained); the aggregate
-- total; each grain's sum; and whether they agree. Plus the rollup record and
-- the last nightly runs. Counts only — never an event, order or product id.
create or replace function public.analytics_reconcile(p_day date)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $fn$
declare
  v_from timestamptz;
  v_to   timestamptz;
  v_run  public.analytics_daily_runs%rowtype;
  v_rows jsonb;
  v_ok   boolean;
begin
  if not public.can_read_analytics() then
    raise exception 'Only admins can view analytics';
  end if;
  if p_day is null then
    raise exception 'analytics_reconcile: a day is required';
  end if;
  v_from := public.analytics_day_start(p_day);
  v_to   := public.analytics_day_start(p_day + 1);
  select * into v_run from public.analytics_daily_runs where day = p_day;

  with types as (
    select unnest(array['page_view', 'product_view', 'search', 'wishlist_add', 'wishlist_remove',
                        'cart_add', 'cart_remove', 'checkout_start', 'whatsapp_click', 'purchase']) t
  ),
  raw as (
    select event_type,
           count(*) filter (where traffic = 'customer') c,
           count(*) filter (where traffic = 'internal') i,
           count(*) filter (where traffic = 'test') t,
           sum(quantity) filter (where traffic = 'customer') q
      from public.analytics_events
     where occurred_at >= v_from and occurred_at < v_to
     group by event_type
  ),
  agg as (
    select event_type,
           sum(events) filter (where grain = 'total')    total,
           sum(units)  filter (where grain = 'total')    total_units,
           sum(events) filter (where grain = 'product')  product,
           sum(units)  filter (where grain = 'product')  product_units,
           sum(events) filter (where grain = 'location') location,
           sum(events) filter (where grain = 'device')   device,
           sum(events) filter (where grain = 'source')   source,
           sum(events) filter (where grain = 'search')   search
      from public.analytics_daily where day = p_day group by event_type
  ),
  lines as (
    select y.t as event_type, coalesce(r.c, 0) c, coalesce(r.i, 0) i, coalesce(r.t, 0) t, r.q,
           coalesce(a.total, 0) total, a.total_units, a.product, a.product_units,
           a.location, a.device, a.source, a.search
      from types y
      left join raw r on r.event_type = y.t
      left join agg a on a.event_type = y.t
     where r.event_type is not null or a.event_type is not null
  )
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'event_type', event_type,
           'raw_customer', case when v_run.raw_purged_at is null then c end,
           'raw_internal', case when v_run.raw_purged_at is null then i end,
           'raw_test',     case when v_run.raw_purged_at is null then t end,
           'aggregate_total', total, 'aggregate_units', total_units,
           'product_grain', product, 'product_grain_units', product_units,
           'location_grain', location, 'device_grain', device, 'source_grain', source, 'search_grain', search,
           -- Raw customer = total (while raw exists), and every grain this
           -- event type belongs to sums back to the total. A purchase can
           -- list several products, so its product grain is checked on units.
           'matches',
             (v_run.raw_purged_at is not null or c = total)
             and (event_type not in ('product_view', 'wishlist_add', 'wishlist_remove', 'cart_add', 'cart_remove')
                  or coalesce(product, 0) = total)
             and (event_type <> 'purchase' or coalesce(product_units, 0) = coalesce(total_units, 0))
             and (event_type = 'purchase' or (coalesce(location, 0) = total and coalesce(device, 0) = total
                                              and coalesce(source, 0) = total))
             and (event_type <> 'search' or coalesce(search, 0) = total)
         )) order by event_type), '[]'::jsonb)
    into v_rows
    from lines;

  select coalesce(bool_and((x->>'matches')::boolean), true) into v_ok from jsonb_array_elements(v_rows) x;

  return jsonb_build_object(
    'day', p_day,
    'timezone', 'Asia/Kolkata',
    'utc_from', v_from,
    'utc_to', v_to,
    'rolled_up', v_run.day is not null,
    'rolled_up_at', v_run.rolled_up_at,
    'raw_at_rollup', case when v_run.day is not null then jsonb_build_object(
        'customer', v_run.customer_events, 'internal', v_run.internal_events, 'test', v_run.test_events) end,
    'raw_retained', v_run.raw_purged_at is null,
    'raw_purged_at', v_run.raw_purged_at,
    'by_event_type', v_rows,
    'all_match', v_ok and v_run.day is not null,
    'last_jobs', coalesce((
      select jsonb_agg(jsonb_build_object('ran_at', ran_at, 'job', job, 'ok', ok,
                                          'error', detail->>'error', 'stage', detail->>'stage') order by ran_at desc)
        from (select * from public.analytics_job_log order by ran_at desc limit 5) j), '[]'::jsonb)
  );
end;
$fn$;

revoke execute on function public.analytics_reconcile(date) from public, anon;
grant execute on function public.analytics_reconcile(date) to authenticated, service_role;

-- ── Refuse to commit anything but the intended state ──
do $$
declare
  problems text[] := array[]::text[];
  t text;
  f text;
begin
  foreach t in array array['analytics_daily', 'analytics_daily_runs', 'analytics_job_log'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      problems := problems || (t || ' has RLS off');
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then
      problems := problems || (t || ' has a policy');
    end if;
    foreach f in array array['anon', 'authenticated', 'service_role'] loop
      if has_table_privilege(f, 'public.' || t, 'select') or has_table_privilege(f, 'public.' || t, 'insert')
         or has_table_privilege(f, 'public.' || t, 'update') or has_table_privilege(f, 'public.' || t, 'delete') then
        problems := problems || (t || ' is reachable by ' || f);
      end if;
    end loop;
  end loop;
  foreach f in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(f, 'public.analytics_rollup_day(date)', 'execute')
       or has_function_privilege(f, 'public.analytics_nightly()', 'execute')
       or has_function_privilege(f, 'public.analytics_purge(integer)', 'execute') then
      problems := problems || ('rollup, nightly or purge is executable by ' || f);
    end if;
  end loop;
  if has_function_privilege('anon', 'public.analytics_report(date, date, text)', 'execute')
     or has_function_privilege('anon', 'public.analytics_reconcile(date)', 'execute') then
    problems := problems || 'report or reconcile is executable by anon'::text;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public'
              and table_name = 'analytics_daily'
              and column_name in ('visitor_id', 'session_id', 'user_id', 'customer_email', 'email', 'visitors',
                                  'sessions', 'unique_visitors', 'gender', 'ip', 'ip_address', 'user_agent',
                                  'latitude', 'longitude', 'city', 'order_id', 'revenue', 'revenue_inr')) then
    problems := problems || 'analytics_daily has a column it must not have'::text;
  end if;
  if public.analytics_day_start(date '2026-10-11') <> timestamptz '2026-10-10 18:30:00+00' then
    problems := problems || 'IST day start is wrong'::text;
  end if;
  if array_length(problems, 1) > 0 then
    raise exception 'MIGRATION_0069_SELF_CHECK_FAILED: %', array_to_string(problems, '; ');
  end if;
end $$;

-- ── Verify ────────────────────────────────────
select c.relname as table_name, c.relrowsecurity as rls,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
  from pg_class c
 where c.relnamespace = 'public'::regnamespace
   and c.relname in ('analytics_daily', 'analytics_daily_runs', 'analytics_job_log')
 order by c.relname;
