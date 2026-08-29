-- 0059 — the project's AI spend for one UTC day, enforced rather than observed
--
-- Phase 1 made the concierge's cost visible. Visible is not bounded: the only
-- limits that existed were per-request and per-identity, and identities are
-- cheap — an anonymous caller is a hashed IP and an account costs an email
-- address. Nothing capped what the PROJECT could spend in a day.
--
-- ══ WHY NOT chat_usage ══
--
-- 0019 already holds an atomic, row-locked counter with a window, and
-- chat_consume() takes an arbitrary text key, so a row keyed 'global:daily'
-- looked free. It is not, because of one line in 0019:
--
--     delete from chat_usage where window_start < now() - (p_window * 3);
--
-- That cleanup uses the CALLING invocation's window, not the row's. Every
-- ordinary chat request passes '1 hour', so every ordinary chat request deletes
-- any row whose window_start is more than three hours old — including a daily
-- row, which by design holds a window_start at the start of the day. The
-- ceiling would silently reset itself roughly every three hours, and it would
-- not error: the counter would simply be gone and the next read would report
-- zero spent. A budget that resets itself eight times a day is worse than no
-- budget, because it looks like one.
--
-- Nothing here reuses that pattern. The only deletion in this file is a manual
-- retention function that cannot reach the current day (see the bottom).
--
-- ══ WHY RESERVE-THEN-RECONCILE, NOT READ-THEN-WRITE ══
--
-- "Read the total, call the model, add what it cost" is a check-then-act. Two
-- requests arriving together both read $4.96, both decide there is room, and
-- both spend — the ceiling is crossed by exactly the concurrency it exists to
-- survive. So a request RESERVES its maximum possible cost before the provider
-- is called, and reconciles down to the real figure afterwards. The check and
-- the reservation happen in one statement whose guard lives in its WHERE
-- clause, which is the same shape reserve_stock has used since 0021.
--
-- ══ WHAT THIS IS NOT ══
--
-- Not a billing system. There is no per-customer attribution, no invoice, no
-- currency conversion and no history beyond a daily aggregate. It answers one
-- question — "may we spend more today?" — and holds the minimum needed to
-- answer it honestly.

-- ── UTC, said out loud ────────────────────────
-- current_date follows the session's TimeZone, which is a property of whoever
-- happens to be connected. A budget that rolls over at a different moment
-- depending on the caller is not a daily budget. Every day boundary in this
-- file goes through this function.
create or replace function public.ai_utc_day()
returns date
language sql
immutable
set search_path = public
as $fn$ select (now() at time zone 'utc')::date $fn$;

comment on function public.ai_utc_day() is
  'Today in UTC. Used by every day boundary in the AI spend accounting so the
   ceiling does not roll over at a time that depends on the caller''s TimeZone.';

-- ── The day's account ─────────────────────────
-- One authoritative row per UTC day.
--
-- numeric, never float. These figures are added thousands of times a day and
-- compared against a ceiling; binary floating point drifts under exactly that
-- workload, and a ceiling compared against a drifted total is a ceiling that
-- sometimes is not one. 14,6 holds ten million dollars to a ten-thousandth of
-- a cent, which is several orders of magnitude more headroom than this shop
-- will ever need and costs nothing.
--
-- NO PII. There is no customer column here and there must never be one: not an
-- email, not a session, not a hashed identity, not a trace id. The question is
-- "what has the project spent today", and any per-person column would turn an
-- accounting table into a behavioural record of who asked what and when.
create table if not exists ai_daily_spend (
  day                 date primary key,
  -- Actually spent: reconciled against what the provider reported.
  committed_usd       numeric(14,6) not null default 0,
  -- Held by requests that are in flight and not yet reconciled.
  reserved_usd        numeric(14,6) not null default 0,
  model_calls         bigint        not null default 0,
  input_tokens        bigint        not null default 0,
  output_tokens       bigint        not null default 0,
  cache_read_tokens   bigint        not null default 0,
  cache_write_tokens  bigint        not null default 0,
  requests            bigint        not null default 0,
  created_at          timestamptz   not null default now(),
  updated_at          timestamptz   not null default now(),
  -- Neither total may go negative. A negative total is not a small accounting
  -- error, it is free budget, so the database refuses it outright rather than
  -- trusting every future caller to have got its arithmetic right.
  constraint ai_daily_spend_committed_non_negative check (committed_usd >= 0),
  constraint ai_daily_spend_reserved_non_negative  check (reserved_usd  >= 0)
);

comment on table ai_daily_spend is
  'Project-wide AI spend for one UTC day. Aggregate only — no customer, session
   or content data of any kind. Written exclusively by the ai_budget_* functions.';

-- ── Reservations in flight ────────────────────
-- One row per request that has been granted budget. Exists for exactly two
-- reasons: so a reconciliation can be made idempotent (a retry must not charge
-- twice), and so a reservation whose request died can be swept.
--
-- The id is a server-generated uuid and is the ONLY identifier here. It is not
-- derived from a customer, a session, an address or a trace — it identifies a
-- reservation and nothing else, and it is meaningless the moment its day is
-- pruned.
create table if not exists ai_spend_reservations (
  id            uuid primary key default gen_random_uuid(),
  day           date          not null,
  reserved_usd  numeric(14,6) not null,
  -- reserved → finalized (reconciled normally) or expired (swept after a crash)
  state         text          not null default 'reserved',
  actual_usd    numeric(14,6),
  created_at    timestamptz   not null default now(),
  finalized_at  timestamptz,
  constraint ai_spend_reservations_state_valid
    check (state in ('reserved', 'finalized', 'expired')),
  constraint ai_spend_reservations_amount_non_negative
    check (reserved_usd >= 0)
);

comment on table ai_spend_reservations is
  'Budget held by an in-flight AI request. No customer, session or content data.
   The id is random and server-generated; it identifies a reservation only.';

-- Partial: only outstanding reservations are ever scanned, and they are few.
create index if not exists ai_spend_reservations_open_idx
  on ai_spend_reservations (created_at)
  where state = 'reserved';

-- ── Security ──────────────────────────────────
-- Same model as chat_usage (0019): RLS on, NO policies at all, every grant to
-- anon and authenticated revoked, and the service role — which bypasses RLS —
-- as the only reachable identity.
--
-- RLS alone would not be enough. RLS filters rows for roles that have table
-- privileges; a role with no privilege is refused before RLS is consulted, and
-- a role with privilege and no policy sees nothing. Doing both means a mistake
-- in either one is not sufficient on its own to expose the table.
alter table ai_daily_spend        enable row level security;
alter table ai_spend_reservations enable row level security;

revoke all on ai_daily_spend        from anon, authenticated;
revoke all on ai_spend_reservations from anon, authenticated;
grant all on ai_daily_spend        to service_role;
grant all on ai_spend_reservations to service_role;

-- ── Reserve ───────────────────────────────────
-- Ask for room to spend up to p_amount today, given a ceiling of p_limit.
--
-- ══ THE CONCURRENCY GUARANTEE ══
--
-- The check and the reservation are ONE statement, and the check lives in its
-- WHERE clause. Under READ COMMITTED, when a second transaction's UPDATE meets
-- a row the first has locked, it waits; when the first commits, the second
-- re-evaluates its WHERE against the NEW row version before proceeding. So the
-- second caller sees the first caller's reservation and is refused. Two
-- requests cannot both read $4.96 and both proceed, because neither of them
-- reads anything — they both attempt a conditional write and at most one wins.
--
-- Returns jsonb rather than raising on refusal: being over budget is an
-- expected operating state, not an error, and a caller should not have to catch
-- an exception to discover it.
create or replace function public.ai_budget_reserve(
  p_amount               numeric,
  p_limit                numeric,
  p_reservation_ttl      interval default interval '15 minutes'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_day       date := ai_utc_day();
  v_id        uuid;
  v_affected  integer;
  v_committed numeric(14,6);
  v_reserved  numeric(14,6);
begin
  -- Reject anything that is not a usable amount BEFORE it can reach the
  -- arithmetic. NaN deserves its own check: in Postgres numeric ordering NaN
  -- compares as greater than every non-NaN value and equal to itself, so
  -- `p_amount >= 0` is TRUE for NaN and a naive guard would wave it through to
  -- poison every total it touched.
  if p_amount is null or p_amount = 'NaN'::numeric or p_amount < 0 then
    raise exception 'ai_budget_reserve: amount must be a non-negative number, got %', p_amount;
  end if;
  if p_limit is null or p_limit = 'NaN'::numeric or p_limit < 0 then
    raise exception 'ai_budget_reserve: limit must be a non-negative number, got %', p_limit;
  end if;

  -- Sweep reservations whose request never came back, and charge them.
  --
  -- CHARGED, NOT REFUNDED, because we cannot know whether the provider billed
  -- for work we never saw the result of. Assuming it did is the conservative
  -- direction and the amount is bounded by the per-request ceiling. This is
  -- keyed on each reservation's OWN created_at — unlike 0019's cleanup, which
  -- keys on the caller's window and is why that table could not be reused.
  with stale as (
    update ai_spend_reservations
       set state = 'expired',
           actual_usd = reserved_usd,
           finalized_at = now()
     where state = 'reserved'
       and created_at < now() - p_reservation_ttl
    returning day, reserved_usd
  ),
  agg as (
    select day, sum(reserved_usd) as amount from stale group by day
  )
  update ai_daily_spend d
     set committed_usd = d.committed_usd + agg.amount,
         reserved_usd  = greatest(d.reserved_usd - agg.amount, 0),
         updated_at    = now()
    from agg
   where d.day = agg.day;

  -- The day's row must exist before it can be conditionally updated. Separate
  -- from the guarded UPDATE below on purpose: an INSERT ... ON CONFLICT DO
  -- UPDATE cannot express "only if the result would stay under the ceiling".
  insert into ai_daily_spend (day) values (v_day)
  on conflict (day) do nothing;

  -- The guarded write. Everything above is bookkeeping; this is the ceiling.
  update ai_daily_spend d
     set reserved_usd = d.reserved_usd + p_amount,
         requests     = d.requests + 1,
         updated_at   = now()
   where d.day = v_day
     and d.committed_usd + d.reserved_usd + p_amount <= p_limit
  returning d.committed_usd, d.reserved_usd
      into v_committed, v_reserved;

  get diagnostics v_affected = row_count;

  if v_affected = 0 then
    select committed_usd, reserved_usd into v_committed, v_reserved
      from ai_daily_spend where day = v_day;
    return jsonb_build_object(
      'allowed',   false,
      'day',       v_day,
      'committed', v_committed,
      'reserved',  v_reserved,
      'limit',     p_limit
    );
  end if;

  insert into ai_spend_reservations (day, reserved_usd)
  values (v_day, p_amount)
  returning id into v_id;

  return jsonb_build_object(
    'allowed',        true,
    'reservation_id', v_id,
    'day',            v_day,
    'committed',      v_committed,
    'reserved',       v_reserved,
    'limit',          p_limit
  );
end;
$fn$;

-- ── Finalize ──────────────────────────────────
-- Reconcile a reservation against what the provider actually reported.
--
-- IDEMPOTENT. `for update` on the reservation row serialises concurrent or
-- retried finalisations, and a row that is no longer 'reserved' is reported
-- back as already-done rather than charged again. This is what stops a Vercel
-- re-execution, or a retry after a dropped connection, from billing the day
-- twice for one request.
--
-- A NULL actual is NOT zero. It means "we could not establish what this cost" —
-- an unpriced model, or usage we could not read — and the honest response is to
-- charge the full reservation rather than to quietly make the request free.
create or replace function public.ai_budget_finalize(
  p_reservation_id    uuid,
  p_actual_usd        numeric default null,
  p_model_calls       integer default 0,
  p_input_tokens      bigint  default 0,
  p_output_tokens     bigint  default 0,
  p_cache_read_tokens bigint  default 0,
  p_cache_write_tokens bigint default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  r        ai_spend_reservations%rowtype;
  v_charge numeric(14,6);
begin
  if p_reservation_id is null then
    raise exception 'ai_budget_finalize: reservation id is required';
  end if;

  -- NaN again, for the same reason as above.
  if p_actual_usd is not null and (p_actual_usd = 'NaN'::numeric or p_actual_usd < 0) then
    raise exception 'ai_budget_finalize: actual cost must be non-negative, got %', p_actual_usd;
  end if;

  select * into r from ai_spend_reservations
   where id = p_reservation_id
     for update;

  if not found then
    -- Not an exception: a caller retrying after the row was pruned should get a
    -- verdict it can act on, not a failure it has to interpret.
    return jsonb_build_object('ok', false, 'reason', 'unknown_reservation');
  end if;

  if r.state <> 'reserved' then
    return jsonb_build_object(
      'ok', true, 'idempotent', true, 'state', r.state, 'charged', r.actual_usd
    );
  end if;

  -- Unknown cost charges the whole reservation. An actual above the reservation
  -- is charged in full as well: it is what was really spent, and recording less
  -- than the truth to protect a ceiling would corrupt every figure downstream.
  -- The day may finish over its limit as a result; the next reservation is then
  -- refused, which is the correct behaviour.
  v_charge := case
                when p_actual_usd is null then r.reserved_usd
                else p_actual_usd
              end;

  update ai_daily_spend d
     set committed_usd      = d.committed_usd + v_charge,
         -- greatest(): the reservation being released is the one this row
         -- created, so this cannot legitimately go negative — but a check
         -- constraint that fires here would fail a customer's request over
         -- bookkeeping, and the constraint exists to catch the bug, not to be
         -- the thing that breaks.
         reserved_usd       = greatest(d.reserved_usd - r.reserved_usd, 0),
         model_calls        = d.model_calls + greatest(coalesce(p_model_calls, 0), 0),
         input_tokens       = d.input_tokens + greatest(coalesce(p_input_tokens, 0), 0),
         output_tokens      = d.output_tokens + greatest(coalesce(p_output_tokens, 0), 0),
         cache_read_tokens  = d.cache_read_tokens + greatest(coalesce(p_cache_read_tokens, 0), 0),
         cache_write_tokens = d.cache_write_tokens + greatest(coalesce(p_cache_write_tokens, 0), 0),
         updated_at         = now()
   where d.day = r.day;

  update ai_spend_reservations
     set state = 'finalized', actual_usd = v_charge, finalized_at = now()
   where id = p_reservation_id;

  return jsonb_build_object(
    'ok', true, 'idempotent', false, 'charged', v_charge, 'day', r.day
  );
end;
$fn$;

-- ── Read ──────────────────────────────────────
-- Deliberately separate from the write path, and deliberately read-only. A
-- combined "check and add" would mean a pre-flight check incremented the
-- counter, so a refused request would push its own ceiling further away every
-- time it was refused.
create or replace function public.ai_budget_today()
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(
    (select to_jsonb(d) from ai_daily_spend d where d.day = ai_utc_day()),
    jsonb_build_object('day', ai_utc_day(), 'committed_usd', 0, 'reserved_usd', 0)
  );
$fn$;

-- ── Retention ─────────────────────────────────
-- 400 days: thirteen months, so a year-on-year comparison is possible without
-- keeping data forever. At one row per day that is ~365 rows a year and a few
-- tens of kilobytes — the retention is for tidiness, not for space.
--
-- IT CANNOT REACH TODAY. p_keep_days is forced to at least 1 and the predicate
-- is strictly less-than, so the newest day this can delete is yesterday. It is
-- also NOT called from the request path: a delete on every chat message would
-- be waste, and an automatic cleanup that runs during a customer's request is
-- how 0019's cleanup came to delete something it should not have.
create or replace function public.ai_budget_prune(p_keep_days integer default 400)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_keep  integer := greatest(coalesce(p_keep_days, 400), 1);
  v_days  integer;
  v_resv  integer;
begin
  delete from ai_daily_spend
   where day < ai_utc_day() - v_keep;
  get diagnostics v_days = row_count;

  -- Settled reservations older than a month. Anything still 'reserved' is left
  -- alone: it is either in flight or awaiting the sweep, and deleting it would
  -- release budget nobody decided to release.
  delete from ai_spend_reservations
   where state <> 'reserved'
     and created_at < now() - interval '30 days';
  get diagnostics v_resv = row_count;

  return jsonb_build_object('days_deleted', v_days, 'reservations_deleted', v_resv);
end;
$fn$;

-- ── Grants ────────────────────────────────────
-- security definer means these run as their owner, so who may EXECUTE them is
-- the whole access control story. Revoked from everyone first — including
-- `public`, which is granted execute by default on new functions and is the
-- step most easily forgotten.
revoke execute on function public.ai_utc_day()                                       from public, anon, authenticated;
revoke execute on function public.ai_budget_reserve(numeric, numeric, interval)      from public, anon, authenticated;
revoke execute on function public.ai_budget_finalize(uuid, numeric, integer, bigint, bigint, bigint, bigint) from public, anon, authenticated;
revoke execute on function public.ai_budget_today()                                  from public, anon, authenticated;
revoke execute on function public.ai_budget_prune(integer)                           from public, anon, authenticated;

grant execute on function public.ai_utc_day()                                        to service_role;
grant execute on function public.ai_budget_reserve(numeric, numeric, interval)       to service_role;
grant execute on function public.ai_budget_finalize(uuid, numeric, integer, bigint, bigint, bigint, bigint) to service_role;
grant execute on function public.ai_budget_today()                                   to service_role;
grant execute on function public.ai_budget_prune(integer)                            to service_role;

-- ── Verify ────────────────────────────────────
-- Existence and access only. Calling ai_budget_reserve here would spend a real
-- allowance and leave a row behind, and a migration must not have side effects
-- on live behaviour.
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'ai_daily_spend')            as daily_table,
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'ai_spend_reservations')     as reservations_table,
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
     and proname in ('ai_budget_reserve','ai_budget_finalize','ai_budget_today',
                     'ai_budget_prune','ai_utc_day'))                            as functions,
  (select bool_and(relrowsecurity) from pg_class
    where relname in ('ai_daily_spend','ai_spend_reservations'))                 as rls_on,
  (select count(*) from pg_policies
    where tablename in ('ai_daily_spend','ai_spend_reservations'))               as policies_should_be_zero,
  (select count(*) from information_schema.role_table_grants
    where table_name in ('ai_daily_spend','ai_spend_reservations')
      and grantee in ('anon','authenticated'))                                   as client_grants_should_be_zero,
  (select count(*) from information_schema.role_routine_grants
    where routine_name like 'ai_budget%'
      and grantee in ('anon','authenticated','PUBLIC'))                          as client_execute_should_be_zero,
  (select count(*) from ai_daily_spend)                                          as rows_now;
