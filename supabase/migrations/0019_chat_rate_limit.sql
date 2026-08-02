-- 0019 — Ask Wovenne usage cap
--
-- The concierge calls a paid API on every message, from a public endpoint with
-- no account behind it. Left open, one script can run up a bill overnight.
--
-- A cap rather than a login wall, deliberately: the widget earns its keep
-- BEFORE trust exists — "is this real handloom?", "how does the sizing run?" —
-- and demanding an account to ask costs more conversions than it saves in API
-- spend. So the first several messages are free to anyone, and only sustained
-- use is stopped.
--
-- Counted in the database rather than in memory because the API route runs
-- serverless: each instance has its own memory, so an in-process counter is
-- reset by the next cold start and resets entirely under the concurrency an
-- abuser would generate. This has to be shared state to mean anything.

-- ── Who has asked how much, lately ────────────
-- Keyed by a HASH of the caller's IP, never the address itself. The count is
-- all we need, and an IP is personal data under the DPDP Act — storing a digest
-- keeps the rate limit working while leaving nothing readable in the table.
--
-- The hash is pseudonymisation, not secrecy: it is salted with a constant in
-- the application, so anyone holding both the code and the table could confirm
-- a guessed address. That is an acceptable trade for a rate limiter, and moving
-- the salt to an environment variable later would close it.
create table if not exists chat_usage (
  ip_hash      text primary key,
  window_start timestamptz not null default now(),
  message_count integer not null default 0
);

alter table chat_usage enable row level security;
-- No policies at all: only the service role reaches this, and it bypasses RLS.
-- A visitor must never be able to read or reset their own counter.
revoke all on chat_usage from anon, authenticated;
grant all on chat_usage to service_role;

create index if not exists chat_usage_window_idx on chat_usage (window_start);

-- ── Spend one message from the caller's allowance ──
-- Returns {allowed, remaining, reset_at}. Increments only when allowed, so a
-- blocked caller cannot push their own reset further away by retrying.
create or replace function public.chat_consume(
  p_ip_hash text,
  p_limit   integer default 10,
  p_window  interval default interval '1 hour'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  row_now      chat_usage%rowtype;
  window_fresh boolean;
begin
  -- Opportunistic cleanup: without it the table grows one row per visitor
  -- forever. Cheap because the index is on the same column.
  delete from chat_usage where window_start < now() - (p_window * 3);

  insert into chat_usage (ip_hash, window_start, message_count)
  values (p_ip_hash, now(), 0)
  on conflict (ip_hash) do nothing;

  -- FOR UPDATE: two messages arriving together must not both read the old
  -- count and each decide they are within the limit.
  select * into row_now from chat_usage where ip_hash = p_ip_hash for update;

  window_fresh := row_now.window_start < now() - p_window;
  if window_fresh then
    update chat_usage
       set window_start = now(), message_count = 1
     where ip_hash = p_ip_hash
    returning * into row_now;

    return jsonb_build_object(
      'allowed', true,
      'remaining', p_limit - 1,
      'reset_at', row_now.window_start + p_window
    );
  end if;

  if row_now.message_count >= p_limit then
    return jsonb_build_object(
      'allowed', false,
      'remaining', 0,
      'reset_at', row_now.window_start + p_window
    );
  end if;

  update chat_usage
     set message_count = message_count + 1
   where ip_hash = p_ip_hash
  returning * into row_now;

  return jsonb_build_object(
    'allowed', true,
    'remaining', p_limit - row_now.message_count,
    'reset_at', row_now.window_start + p_window
  );
end;
$fn$;

revoke execute on function public.chat_consume(text, integer, interval) from public, anon, authenticated;
grant execute on function public.chat_consume(text, integer, interval) to service_role;

-- ── Verify ────────────────────────────────────
-- Counts and existence only. Calling chat_consume here would spend a real
-- allowance and leave a row behind, and a migration should not have side
-- effects on live behaviour.
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'chat_usage') as usage_table,
  (select count(*) from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname = 'chat_consume') as consume_fn,
  (select count(*) from chat_usage) as rows_now;
