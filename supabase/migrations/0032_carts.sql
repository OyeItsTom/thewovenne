-- 0032 — Saved carts, and the abandoned-cart trigger
--
-- SIGNED-IN CUSTOMERS ONLY, deliberately.
--
-- Catching guests would mean recording what signed-out visitors browse, keyed
-- to some anonymous identifier — collecting behaviour from people who have
-- agreed to nothing, under a law that treats that as personal data. And it
-- would buy nothing usable: a guest cannot be emailed anyway, because they
-- never consented. So the reach this gives up is reach that could not be acted
-- on.
--
-- One row per customer. A cart is a current intention, not a history; keeping
-- every version would be a browsing log wearing a different hat.

create table if not exists carts (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  items      jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists carts_updated_idx on carts (updated_at desc);

alter table carts enable row level security;

-- Own row only, on every verb. `using` governs which rows are visible to change
-- and `with check` what may be written — both are needed, or one customer could
-- write a cart belonging to another.
do $$ begin
  create policy "Customers manage own cart" on carts for all to authenticated
    using (user_id = auth.uid()) with check (user_id = auth.uid());
exception when duplicate_object then null; end $$;

-- Admins are NOT given read access. Nobody needs to browse what individual
-- customers are considering; the marketing function reads it through a
-- SECURITY DEFINER path that only ever emits counts and product names.
grant select, insert, update, delete on carts to authenticated;
grant all on carts to service_role;

-- ── Marketing targets, now including abandoned carts ──
-- Rewritten rather than extended: the wishlist triggers and the cart trigger
-- read different sources, and a single query trying to serve both would be the
-- kind of thing that quietly returns the wrong list.
--
-- Consent, staff exclusion and the cooldown are unchanged and still the only
-- authority on eligibility.
create or replace function public.marketing_targets(
  p_trigger       text,
  p_cooldown_days integer default 7
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  result jsonb;
  -- How stale a cart must be before it counts as abandoned. Long enough that
  -- someone still shopping is not chased mid-decision.
  stale interval := interval '24 hours';
begin
  if not public.can_read_analytics() then
    raise exception 'Only admins can read marketing targets';
  end if;

  with eligible as (
    select p.id, p.email, p.full_name
      from profiles p
     where p.marketing_consent
       and not p.is_admin
       and p.email is not null
       and not exists (
         select 1 from marketing_sends m
          where m.user_id = p.id
            and m.trigger = p_trigger
            and m.sent_at > now() - (p_cooldown_days || ' days')::interval
       )
  ),
  saved as (
    select w.user_id,
           pv.name,
           pv.slug,
           coalesce(
             (select sum(ps.stock_quantity) from product_sizes ps
               where ps.product_id = w.product_id),
             pv.stock_quantity
           ) as stock
      from wishlists w
      join product_versions pv
        on pv.product_id = w.product_id
       and pv.state = 'published'
       and pv.is_active
  ),
  -- A cart counts as abandoned when it still holds something, has not been
  -- touched for a day, and nothing has been bought since. That last condition
  -- matters: without it, checking out would earn you an email telling you to
  -- finish the order you just completed.
  abandoned as (
    select c.user_id,
           item ->> 'name' as name,
           item ->> 'slug' as slug,
           2147483647      as stock
      from carts c
      join profiles p on p.id = c.user_id
      cross join lateral jsonb_array_elements(c.items) as item
     where jsonb_array_length(c.items) > 0
       and c.updated_at < now() - stale
       and not exists (
         select 1 from orders o
          where lower(o.customer_email) = lower(p.email)
            and o.payment_status = 'paid'
            and o.created_at > c.updated_at
       )
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', e.id,
           'email', e.email,
           'name', e.full_name,
           'items', items.list
         ) order by e.email), '[]'::jsonb)
    into result
  from eligible e
  join lateral (
    select jsonb_agg(jsonb_build_object('name', x.name, 'slug', x.slug, 'stock', x.stock)) as list,
           count(*) as n
      from (
        select s.name, s.slug, s.stock
          from saved s
         where s.user_id = e.id
           and case p_trigger
                 when 'wishlist_waiting' then s.stock > 0
                 when 'low_stock'        then s.stock > 0 and s.stock <= 3
                 else false
               end
        union all
        select a.name, a.slug, a.stock
          from abandoned a
         where a.user_id = e.id
           and p_trigger = 'cart_abandoned'
      ) x
  ) items on items.n > 0;

  return result;
end;
$fn$;

revoke execute on function public.marketing_targets(text, integer) from public, anon;
grant execute on function public.marketing_targets(text, integer) to authenticated, service_role;

-- ── Verify ────────────────────────────────────
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'carts') as carts_table,
  (select count(*) from carts) as cart_rows,
  (select count(*) from profiles where marketing_consent and not is_admin) as consented;
