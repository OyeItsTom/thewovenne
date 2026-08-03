-- 0025 — Analytics aggregates
--
-- A fixed set of read-only aggregate functions. The dashboard reads them, and
-- the AI insights chat will call these same functions rather than writing SQL.
--
-- That is the whole point of doing it this way. A chat box that generates
-- queries against production is one plausible prompt away from dumping every
-- customer's address; these return counts and sums, so exfiltrating PII is not
-- a capability the model has rather than a behaviour it is asked to avoid.
--
-- Every function is admin-gated and SECURITY DEFINER. None returns a raw
-- customer row: no emails, no addresses, no names.
--
-- The gate also admits the service role. That is not a widening: the service
-- key already bypasses RLS and can select from orders directly, so denying it
-- an aggregate protects nothing while making these functions impossible to test
-- from a backend script. Untested SQL is the more likely source of harm — a
-- product-creation path that had never once run shipped broken this week.
--
-- Revenue is split into goods and shipping throughout. Counting postage as
-- revenue quietly inflates average order value, and AOV is the number most
-- likely to be acted on.

-- Who may read the numbers. One definition, so six functions cannot drift.
create or replace function public.can_read_analytics()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select public.is_admin() or auth.role() = 'service_role';
$fn$;

grant execute on function public.can_read_analytics() to authenticated, service_role;

-- ── Headline numbers ──────────────────────────
create or replace function public.analytics_summary(p_days integer default 30)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $fn$
declare
  result jsonb;
begin
  if not public.can_read_analytics() then
    raise exception 'Only admins can view analytics';
  end if;

  select jsonb_build_object(
    'days', p_days,
    -- Paid only. Counting pending orders as revenue would report money that
    -- may never arrive.
    'orders', count(*),
    'revenue', coalesce(sum(total_inr), 0),
    'goods', coalesce(sum(total_inr - shipping_cost_inr), 0),
    'shipping', coalesce(sum(shipping_cost_inr), 0),
    'aov', case when count(*) = 0 then 0
                else round(coalesce(sum(total_inr - shipping_cost_inr), 0) / count(*), 2) end,
    'awaiting_dispatch', count(*) filter (where status in ('placed', 'confirmed')),
    'needs_review', count(*) filter (where needs_review)
  )
  into result
  from orders
  where payment_status = 'paid'
    and created_at >= now() - (p_days || ' days')::interval;

  return result;
end;
$fn$;

-- ── Revenue over time ─────────────────────────
-- Buckets are day, week or month. Empty buckets are generated rather than
-- skipped, so a quiet week shows as a gap at zero instead of the line jumping
-- across it as though nothing happened.
create or replace function public.analytics_revenue(
  p_bucket text default 'day',
  p_days   integer default 30
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $fn$
declare
  result jsonb;
  step   interval;
begin
  if not public.can_read_analytics() then
    raise exception 'Only admins can view analytics';
  end if;

  step := case p_bucket
            when 'month' then interval '1 month'
            when 'week'  then interval '1 week'
            else interval '1 day'
          end;

  with buckets as (
    select generate_series(
      date_trunc(p_bucket, now() - (p_days || ' days')::interval),
      date_trunc(p_bucket, now()),
      step
    ) as bucket
  ),
  sales as (
    select date_trunc(p_bucket, created_at) as bucket,
           sum(total_inr - shipping_cost_inr) as goods,
           sum(shipping_cost_inr)             as shipping,
           count(*)                            as orders
      from orders
     where payment_status = 'paid'
       and created_at >= now() - (p_days || ' days')::interval
     group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'bucket', b.bucket,
           'goods', coalesce(s.goods, 0),
           'shipping', coalesce(s.shipping, 0),
           'orders', coalesce(s.orders, 0)
         ) order by b.bucket), '[]'::jsonb)
    into result
    from buckets b
    left join sales s on s.bucket = b.bucket;

  return result;
end;
$fn$;

-- ── What sold ─────────────────────────────────
-- Read out of orders.items, which is a snapshot taken at purchase. That is
-- deliberate: it reports what was actually sold at the price actually paid,
-- and survives a product being renamed, repriced or deleted afterwards.
create or replace function public.analytics_top_products(
  p_days  integer default 30,
  p_limit integer default 10
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $fn$
declare
  result jsonb;
begin
  if not public.can_read_analytics() then
    raise exception 'Only admins can view analytics';
  end if;

  with lines as (
    select item ->> 'name' as name,
           coalesce((item ->> 'quantity')::integer, 0) as qty,
           coalesce((item ->> 'price_inr')::numeric, 0) as price
      from orders o,
           lateral jsonb_array_elements(coalesce(o.items, '[]'::jsonb)) as item
     where o.payment_status = 'paid'
       and o.created_at >= now() - (p_days || ' days')::interval
  )
  select coalesce(jsonb_agg(x order by (x ->> 'revenue')::numeric desc), '[]'::jsonb)
    into result
  from (
    select jsonb_build_object(
             'name', name,
             'units', sum(qty),
             'revenue', sum(qty * price)
           ) as x
      from lines
     where name is not null
     group by name
     order by sum(qty * price) desc
     limit p_limit
  ) top;

  return result;
end;
$fn$;

-- ── What is running out ───────────────────────
-- Sized and single-stock products in one list, so nothing hides because it is
-- tracked differently.
create or replace function public.analytics_low_stock(p_threshold integer default 3)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $fn$
declare
  result jsonb;
begin
  if not public.can_read_analytics() then
    raise exception 'Only admins can view analytics';
  end if;

  with sized as (
    select pv.name, ps.label as size, ps.stock_quantity as stock
      from product_sizes ps
      join product_versions pv
        on pv.product_id = ps.product_id and pv.state = 'published'
     where ps.stock_quantity <= p_threshold
  ),
  unsized as (
    select pv.name, null::text as size, pv.stock_quantity as stock
      from product_versions pv
     where pv.state = 'published'
       and pv.is_active
       and pv.stock_quantity <= p_threshold
       and not exists (select 1 from product_sizes ps where ps.product_id = pv.product_id)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'name', name, 'size', size, 'stock', stock
         ) order by stock, name), '[]'::jsonb)
    into result
    from (select * from sized union all select * from unsized) all_low;

  return result;
end;
$fn$;

-- ── What people are saving ────────────────────
-- Counts per product. Never who saved it: that is a customer's browsing
-- behaviour, and the aggregate answers the merchandising question without it.
create or replace function public.analytics_wishlist(p_limit integer default 10)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $fn$
declare
  result jsonb;
begin
  if not public.can_read_analytics() then
    raise exception 'Only admins can view analytics';
  end if;

  select coalesce(jsonb_agg(x order by (x ->> 'saves')::integer desc), '[]'::jsonb)
    into result
  from (
    select jsonb_build_object('name', pv.name, 'saves', count(*)) as x
      from wishlists w
      join product_versions pv
        on pv.product_id = w.product_id and pv.state = 'published'
     group by pv.name
     order by count(*) desc
     limit p_limit
  ) top;

  return result;
end;
$fn$;

-- ── Account growth ────────────────────────────
-- Customers only: admins are staff, and counting them as signups would flatter
-- a number that is meant to measure the shop.
create or replace function public.analytics_signups(p_days integer default 30)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $fn$
declare
  result jsonb;
begin
  if not public.can_read_analytics() then
    raise exception 'Only admins can view analytics';
  end if;

  with buckets as (
    select generate_series(
      date_trunc('day', now() - (p_days || ' days')::interval),
      date_trunc('day', now()),
      interval '1 day'
    ) as bucket
  ),
  joins as (
    select date_trunc('day', created_at) as bucket, count(*) as n
      from profiles
     where not is_admin
       and created_at >= now() - (p_days || ' days')::interval
     group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'bucket', b.bucket, 'signups', coalesce(j.n, 0)
         ) order by b.bucket), '[]'::jsonb)
    into result
    from buckets b
    left join joins j on j.bucket = b.bucket;

  return result;
end;
$fn$;

-- ── Grants ────────────────────────────────────
-- authenticated only, and each function checks is_admin() itself. The grant
-- lets an admin's session call it; the check is what decides.
do $$
declare fn text;
begin
  foreach fn in array array[
    'analytics_summary(integer)',
    'analytics_revenue(text, integer)',
    'analytics_top_products(integer, integer)',
    'analytics_low_stock(integer)',
    'analytics_wishlist(integer)',
    'analytics_signups(integer)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated, service_role', fn);
  end loop;
end $$;

-- ── Verify ────────────────────────────────────
-- Does not CALL them: each checks is_admin(), and the SQL editor runs as
-- postgres with no auth.uid(), so calling one would raise and roll everything
-- back. Existence is what belongs in a migration.
select
  (select count(*) from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname like 'analytics_%') as analytics_fns,
  (select count(*) from orders where payment_status = 'paid') as paid_orders,
  (select count(*) from product_sizes) as size_rows,
  (select count(*) from wishlists) as wishlist_rows;
