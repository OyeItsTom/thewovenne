-- 0028 — Let the service role read admin_customers()
--
-- 0027 gated admin_customers() on is_admin() alone, which makes it impossible
-- to exercise from a script: the service key has no auth.uid(), so it is never
-- an admin. The segment logic — four branches, two thresholds, a full outer
-- join between accounts and orders — would ship having never once run.
--
-- This is the same decision made for the analytics functions in 0025, for the
-- same reason, and it is not a widening. The service key already bypasses RLS
-- and can select from profiles and orders directly; denying it a function that
-- reads those very tables protects nothing while leaving the logic untested.
-- Untested SQL is the more likely source of harm here — a product-creation path
-- that had never run shipped broken earlier in this project.
--
-- A separate migration rather than an edit to 0027, because 0027 is already
-- applied. Editing an applied migration leaves the file and the database
-- disagreeing, which is the trap the SUPERSEDED IN PART headers exist to warn
-- about.

create or replace function public.admin_customers()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  result      jsonb;
  min_orders  integer;
  min_spend   numeric;
  actor       text;
begin
  -- can_read_analytics() is admin OR service role, defined in 0025.
  if not public.can_read_analytics() then
    raise exception 'Only admins can view customers';
  end if;

  select coalesce((value ->> 'vip_min_orders')::integer, 3),
         coalesce((value ->> 'vip_min_spend_inr')::numeric, 15000)
    into min_orders, min_spend
    from site_content where key = 'store_settings';

  min_orders := coalesce(min_orders, 3);
  min_spend  := coalesce(min_spend, 15000);

  with
  order_stats as (
    select lower(customer_email) as email,
           count(*)                                       as order_count,
           coalesce(sum(total_inr - shipping_cost_inr), 0) as spend,
           min(created_at)                                 as first_order_at,
           max(created_at)                                 as last_order_at
      from orders
     where payment_status = 'paid'
       and customer_email is not null
     group by lower(customer_email)
  ),
  accounts as (
    select lower(p.email) as email,
           p.id           as user_id,
           p.full_name,
           p.marketing_consent,
           p.created_at   as joined_at,
           (select count(*) from wishlists w where w.user_id = p.id) as wishlist_count
      from profiles p
     where not p.is_admin
  ),
  merged as (
    select coalesce(a.email, o.email)           as email,
           a.user_id,
           a.full_name,
           coalesce(a.marketing_consent, false) as marketing_consent,
           a.joined_at,
           coalesce(a.wishlist_count, 0)        as wishlist_count,
           coalesce(o.order_count, 0)           as order_count,
           coalesce(o.spend, 0)                 as spend,
           o.first_order_at,
           o.last_order_at,
           (a.user_id is not null)              as has_account
      from accounts a
      full outer join order_stats o on o.email = a.email
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'email', m.email,
           'name', m.full_name,
           'has_account', m.has_account,
           'marketing_consent', m.marketing_consent,
           'order_count', m.order_count,
           'spend', m.spend,
           'wishlist_count', m.wishlist_count,
           'joined_at', m.joined_at,
           'first_order_at', m.first_order_at,
           'last_order_at', m.last_order_at,
           'segment', case
             when m.order_count >= min_orders or m.spend >= min_spend then 'vip'
             when m.order_count > 1  then 'regular'
             when m.order_count = 1  then 'new'
             else 'prospect'
           end
         ) order by m.spend desc, m.order_count desc, m.email), '[]'::jsonb)
    into result
    from merged m;

  -- Only logged for a real admin. A script run has no actor, and writing an
  -- audit row with a null actor would dilute a log whose value is that every
  -- entry names someone.
  if auth.uid() is not null then
    select email into actor from profiles where id = auth.uid();
    insert into admin_audit_log (actor_id, actor_email, action, table_name, record_label, changes)
    values (
      auth.uid(), actor, 'view', 'customers', 'customer list',
      jsonb_build_object('rows', jsonb_array_length(result))
    );
  end if;

  return result;
end;
$fn$;

revoke execute on function public.admin_customers() from public, anon;
grant execute on function public.admin_customers() to authenticated, service_role;

-- ── Verify ────────────────────────────────────
select
  (select count(*) from pg_proc
    where pronamespace = 'public'::regnamespace and proname = 'admin_customers') as fn_present,
  (select count(*) from profiles where not is_admin) as customer_accounts,
  (select count(*) from orders where payment_status = 'paid') as paid_orders;
