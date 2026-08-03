-- 0029 — Loyalty points
--
-- A LEDGER, not a balance column. Every award and redemption is a signed row,
-- and the balance is their sum. A single mutable number would let a bug or a
-- retry silently create or destroy points with nothing to reconcile against —
-- and points are money, so "how did this customer end up with 4,000?" has to be
-- answerable.
--
-- Rows are never deleted or edited. A correction is another row.
--
-- Ships INERT. Nothing accrues and nothing can be redeemed until
-- store_settings.loyalty_enabled is true, and the functions check it themselves
-- rather than trusting a caller to have looked.
--
-- Guests earn nothing. Points belong to an account, and a guest checkout has no
-- account to attach them to. An order placed with the same address later, once
-- an account exists, earns from that point on — it is not backdated.

-- What an order spent in points, recorded on the order itself so the money
-- side reconciles without walking the ledger — and so a refund can see what to
-- give back.
alter table orders
  add column if not exists loyalty_points_spent integer not null default 0,
  add column if not exists loyalty_discount_inr numeric(10,2) not null default 0;

create table if not exists loyalty_ledger (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  order_id   uuid references orders(id) on delete set null,
  -- Positive to award, negative to redeem. Never zero: a zero row is noise in a
  -- record whose job is to explain a balance.
  points     integer not null check (points <> 0),
  reason     text not null,
  created_at timestamptz not null default now()
);

create index if not exists loyalty_ledger_user_idx on loyalty_ledger (user_id, created_at desc);
-- One award per order. A retried webhook or a double-clicked verify must not
-- pay out twice, and a partial unique index is a stronger guarantee than
-- remembering to check.
create unique index if not exists loyalty_ledger_one_award_per_order
  on loyalty_ledger (order_id) where points > 0 and order_id is not null;

alter table loyalty_ledger enable row level security;

do $$ begin
  create policy "Customers read own points" on loyalty_ledger
    for select to authenticated using (user_id = auth.uid());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Admins read all points" on loyalty_ledger
    for select to authenticated using (public.is_admin());
exception when duplicate_object then null; end $$;

-- No insert or update grant to anyone but the service role. Points are written
-- by the checkout, never by a browser: a balance the client can add to is a
-- discount anyone can mint.
grant select on loyalty_ledger to authenticated;
grant all on loyalty_ledger to service_role;

-- ── Balance ───────────────────────────────────
create or replace function public.loyalty_balance(p_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(sum(points), 0)::integer
    from loyalty_ledger where user_id = p_user_id;
$fn$;

grant execute on function public.loyalty_balance(uuid) to authenticated, service_role;

-- ── Settings helpers ──────────────────────────
create or replace function public.loyalty_settings()
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(
    (select jsonb_build_object(
       'enabled',        coalesce((value ->> 'loyalty_enabled')::boolean, false),
       'points_per_inr', coalesce((value ->> 'loyalty_points_per_inr')::numeric, 1),
       'inr_per_point',  coalesce((value ->> 'loyalty_inr_per_point')::numeric, 0.25),
       'min_redeem',     coalesce((value ->> 'loyalty_min_redeem')::integer, 200))
       from site_content where key = 'store_settings'),
    '{"enabled": false, "points_per_inr": 1, "inr_per_point": 0.25, "min_redeem": 200}'::jsonb
  );
$fn$;

grant execute on function public.loyalty_settings() to authenticated, service_role;

-- ── Award, once, for a paid order ─────────────
-- Earned on GOODS, not the total: paying postage is not loyalty, and awarding
-- on it would quietly pay people to live far away.
create or replace function public.award_loyalty_points(p_order_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  s        jsonb := public.loyalty_settings();
  ord      record;
  target   uuid;
  earned   integer;
begin
  if not (s ->> 'enabled')::boolean then
    return 0;
  end if;

  select id, customer_email, total_inr, shipping_cost_inr, payment_status
    into ord from orders where id = p_order_id;
  if not found or ord.payment_status <> 'paid' then
    return 0;
  end if;

  -- Points belong to an account. A guest order earns nothing, because there is
  -- nobody to credit.
  select p.id into target
    from profiles p
   where lower(p.email) = lower(ord.customer_email)
     and not p.is_admin
   limit 1;
  if target is null then
    return 0;
  end if;

  earned := floor(
    greatest(ord.total_inr - coalesce(ord.shipping_cost_inr, 0), 0)
    * (s ->> 'points_per_inr')::numeric
  )::integer;

  if earned <= 0 then
    return 0;
  end if;

  -- The unique index makes a repeat call a no-op rather than a second payout.
  insert into loyalty_ledger (user_id, order_id, points, reason)
  values (target, p_order_id, earned, 'Earned on order')
  on conflict (order_id) where points > 0 and order_id is not null do nothing;

  return earned;
end;
$fn$;

revoke execute on function public.award_loyalty_points(uuid) from public, anon, authenticated;
grant execute on function public.award_loyalty_points(uuid) to service_role;

-- ── Redeem, atomically ────────────────────────
-- An advisory lock keyed to the customer serialises their own redemptions, so
-- two checkouts racing cannot each read the same balance and both spend it.
-- Held for the transaction, so it is released whatever happens next.
create or replace function public.redeem_loyalty_points(
  p_user_id  uuid,
  p_points   integer,
  p_order_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  s       jsonb := public.loyalty_settings();
  balance integer;
begin
  if not (s ->> 'enabled')::boolean then
    return jsonb_build_object('ok', false, 'reason', 'Loyalty points are not enabled.');
  end if;
  if p_points <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'Nothing to redeem.');
  end if;
  if p_points < (s ->> 'min_redeem')::integer then
    return jsonb_build_object('ok', false, 'reason',
      format('You need at least %s points to redeem.', s ->> 'min_redeem'));
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  balance := public.loyalty_balance(p_user_id);
  if balance < p_points then
    return jsonb_build_object('ok', false, 'reason', 'Not enough points.',
                              'balance', balance);
  end if;

  insert into loyalty_ledger (user_id, order_id, points, reason)
  values (p_user_id, p_order_id, -p_points, 'Redeemed against an order');

  return jsonb_build_object(
    'ok', true,
    'points', p_points,
    'value_inr', round(p_points * (s ->> 'inr_per_point')::numeric, 2),
    'balance', balance - p_points
  );
end;
$fn$;

revoke execute on function public.redeem_loyalty_points(uuid, integer, uuid) from public, anon, authenticated;
grant execute on function public.redeem_loyalty_points(uuid, integer, uuid) to service_role;

-- ── Verify ────────────────────────────────────
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'loyalty_ledger') as ledger_table,
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
     and proname in ('loyalty_balance','loyalty_settings','award_loyalty_points','redeem_loyalty_points')) as fns,
  (select value ->> 'loyalty_enabled' from site_content where key = 'store_settings') as enabled,
  (select count(*) from loyalty_ledger) as ledger_rows,
  (select count(*) from information_schema.columns
    where table_name = 'orders'
      and column_name in ('loyalty_points_spent','loyalty_discount_inr')) as order_columns;
