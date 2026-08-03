-- 0027 — Customer segments
--
-- One row per customer, whether or not they have an account, with the segment
-- worked out from their orders.
--
-- Guests are included deliberately. Someone who has bought three times without
-- signing up is a real customer, and a view that showed only account-holders
-- would misrepresent the shop — but they are marked, because a guest has no
-- account to log into and cannot have consented to anything.
--
-- Unlike the analytics functions, this one DOES return contact details. An
-- admin needs them to fulfil and support orders; that was the point. So the
-- view is logged: which admin looked at customer data, and when. Reading a
-- customer list is an act worth recording, the same as changing a price.
--
-- Thresholds come from store_settings so VIP stays editable without a deploy.

create or replace function public.admin_customers()
returns jsonb
language plpgsql
security definer
-- VOLATILE, not stable: it writes the audit row below.
set search_path = public
as $fn$
declare
  result      jsonb;
  min_orders  integer;
  min_spend   numeric;
  actor       text;
begin
  if not public.is_admin() then
    raise exception 'Only admins can view customers';
  end if;

  select coalesce((value ->> 'vip_min_orders')::integer, 3),
         coalesce((value ->> 'vip_min_spend_inr')::numeric, 15000)
    into min_orders, min_spend
    from site_content where key = 'store_settings';

  min_orders := coalesce(min_orders, 3);
  min_spend  := coalesce(min_spend, 15000);

  with
  -- Orders keyed by the address that placed them, lower-cased so the same
  -- person typing Tom@ and tom@ is one customer rather than two.
  order_stats as (
    select lower(customer_email) as email,
           count(*)                              as order_count,
           coalesce(sum(total_inr - shipping_cost_inr), 0) as spend,
           min(created_at)                       as first_order_at,
           max(created_at)                       as last_order_at
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
           p.marketing_consent_at,
           p.created_at   as joined_at,
           (select count(*) from wishlists w where w.user_id = p.id) as wishlist_count
      from profiles p
     where not p.is_admin
  ),
  merged as (
    select coalesce(a.email, o.email)          as email,
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
             -- VIP on EITHER threshold: orders alone miss the single large
             -- purchase, spend alone misses the loyal buyer of small things.
             when m.order_count >= min_orders or m.spend >= min_spend then 'vip'
             when m.order_count > 1  then 'regular'
             when m.order_count = 1  then 'new'
             else 'prospect'
           end
         ) order by m.spend desc, m.order_count desc, m.email), '[]'::jsonb)
    into result
    from merged m;

  -- Who looked, and when. Deliberately records only that customer data was
  -- viewed and how many rows — not the rows themselves, which would copy every
  -- customer's address into the audit log every time someone opened the page.
  select email into actor from profiles where id = auth.uid();
  insert into admin_audit_log (actor_id, actor_email, action, table_name, record_label, changes)
  values (
    auth.uid(), actor, 'view', 'customers', 'customer list',
    jsonb_build_object('rows', jsonb_array_length(result))
  );

  return result;
end;
$fn$;

revoke execute on function public.admin_customers() from public, anon;
grant execute on function public.admin_customers() to authenticated;

-- ── Verify ────────────────────────────────────
-- Not called here: it checks is_admin(), and the SQL editor runs as postgres
-- with no auth.uid(), so calling it would raise and roll this back.
select
  (select count(*) from pg_proc
    where pronamespace = 'public'::regnamespace and proname = 'admin_customers') as fn_present,
  (select count(*) from profiles where not is_admin) as customer_accounts,
  (select count(distinct lower(customer_email)) from orders
    where payment_status = 'paid' and customer_email is not null) as ordering_emails,
  (select value -> 'vip_min_orders' from site_content where key = 'store_settings') as vip_orders,
  (select value -> 'vip_min_spend_inr' from site_content where key = 'store_settings') as vip_spend;
